const { Pool } = require('pg');
const Y = require('yjs');
const { retryWithBackoff } = require('./retry');
// Display-only cache invalidation on document deletion (045 review, LOW-4). The
// resolver imports nothing from here, so this direction closes no cycle.
const resupplyResolution = require('./resupply-resolution');

/**
 * Fixed int4 namespace for the per-document clock-acquisition advisory lock
 * (feature 023 R1/FR-002). `pg_advisory_xact_lock(NS, hashtext(doc_guid))`
 * serializes MAX+1 + INSERT for one document across every instance; a hash
 * collision merely over-serializes two unrelated docs (never corrupts), and
 * the transaction scope auto-releases the lock at COMMIT/ROLLBACK. The value
 * is arbitrary but distinct so it never collides with any other advisory-lock
 * user in this database.
 */
const CLOCK_LOCK_NAMESPACE = 0x02300023;

/**
 * PostgreSQL persistence adapter for Yjs
 * Implements the same interface as LeveldbPersistence
 */
/**
 * ── Environment knobs, in one place (feature 042, FR-015) ────────────────────
 *
 * They are split into two readers because they are read at DIFFERENT TIMES, and
 * that timing is behavior, not an accident:
 *
 *  - the POOL knobs are read once, when the pool is constructed. Changing them
 *    later cannot affect a pool that already exists.
 *  - the GAP-RETRY knobs are read on EVERY fetch, and validate their input. A
 *    deployment can retune read patience without a restart, and that is the
 *    point — so these must not be hoisted to module load.
 *
 * Co-locating the parsing without collapsing the timing is the whole exercise.
 */

/** Pool knobs — read ONCE at construction. No validation, matching prior behavior. */
function readPoolEnv() {
  return {
    max: Number(process.env.DB_POOL_MAX ?? 20),
    acquireTimeoutMs: Number(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS ?? 5000),
    statementTimeoutMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30000),
  };
}

/** Gap-retry knobs — read on EVERY call, fully validated, with defaults 2 and [100, 300]. */
function readGapRetryEnv() {
  const maxRetriesRaw = parseInt(process.env.COLLAB_READ_GAP_RETRIES, 10);
  return {
    maxRetries: Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0 ? maxRetriesRaw : 2,
    delays: (process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS || '100,300')
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0),
  };
}

class PostgresPersistence {
  /**
   * @param {string|object} connectionStringOrConfig - PostgreSQL connection string or config object
   * @param {object} opts - Additional options
   */
  constructor(connectionStringOrConfig, opts = {}) {
    const baseConfig = typeof connectionStringOrConfig === 'string'
      ? { connectionString: connectionStringOrConfig }
      : { ...connectionStringOrConfig };

    // Bound the app pool (feature 010, US5/FR-023, RD-7). App-pool sessions only —
    // migrations (script/migrate.js) and backup processes open their own
    // connections and are untouched.
    //   max                     — cap concurrent connections
    //   connectionTimeoutMillis — fail fast when the pool is saturated
    //   statement_timeout       — server-side kill for runaway queries (per session)
    //
    // The per-session statement_timeout protects the RUNTIME app, but the same
    // constructor is reused by data-migration/backfill scripts that construct a
    // PostgresPersistence to walk the whole update log (create-document-search-
    // index / add-title-to-documents migrations, backfill-document-titles). A
    // legitimate >30s backfill over a large log would abort mid-statement and
    // fail the migrate Job on a fresh restore. Such call sites pass
    // `{ statementTimeout: false }` to opt out; runtime keeps full protection.
    const pool = readPoolEnv();
    const poolConfig = {
      ...baseConfig,
      max: pool.max,
      connectionTimeoutMillis: pool.acquireTimeoutMs,
    };
    if (opts.statementTimeout !== false) {
      poolConfig.statement_timeout = pool.statementTimeoutMs;
    }
    this.pool = new Pool(poolConfig);

    // An IDLE pooled connection breaking is routine (Postgres restart, failover,
    // an idle-timeout reaper, a network blip) and is NOT fatal: the pool discards
    // the dead client and the next acquire dials a new one. But `pg-pool` removes
    // its own error listener from a client while it is checked out and re-emits
    // the failure on the POOL, and an EventEmitter 'error' with no listener
    // throws — which reaches `uncaughtException` and exits the process
    // (server/exception-notifier.js). One reset connection therefore killed the
    // pod, and with several replicas sharing one database a single failover
    // crash-looped ALL of them at once. Log and continue; every query path
    // already has its own error handling and retry.
    this.pool.on('error', (err) => {
      console.error('[postgres] idle client error (pool recovers, not fatal):', err?.message || err);
    });

    // Extract database name for safety checks on destructive operations
    if (poolConfig.connectionString) {
      // Parse database name from connection string (last path segment)
      try {
        const url = new URL(poolConfig.connectionString);
        this._dbName = url.pathname.replace(/^\//, '');
      } catch {
        this._dbName = null;
      }
    } else {
      this._dbName = poolConfig.database || null;
    }

    this.initialized = false;
    this.initPromise = null;

    // Per-document FIFO write queue (feature 023 R1/FR-001): docGuid -> tail
    // promise. Every pool-client storeUpdate enqueues its whole critical
    // section (transient retry + clock acquisition + insert) as one slot so
    // causally ordered updates on this process get strictly increasing clocks.
    // The entry is deleted when its tail settles with no successor; a rejected
    // slot does not break the chain (poisoned-update isolation, D-9).
    this._writeQueues = new Map();
  }

  /**
   * Verify database schema exists
   * Note: Schema should be created via migrations (run `npm run migrate` first)
   * @private
   */
  async _init() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const client = await this.pool.connect();
      try {
        // Verify tables exist (they should be created via migrations)
        const result = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'yjs_updates'
          );
        `);

        if (!result.rows[0].exists) {
          throw new Error(
            'Database schema not found. Please run migrations first: npm run migrate'
          );
        }

        this.initialized = true;
      } finally {
        client.release();
      }
    })();

    return this.initPromise;
  }

  /**
   * Get the current update clock for a document using an existing client connection
   * @private
   * @param {import('pg').PoolClient} client - Database client to use
   * @param {string} docGuid - Document GUID
   * @returns {Promise<number>} Current max clock, or -1 if no updates exist
   */
  async _getCurrentUpdateClock(client, docGuid) {
    const result = await client.query(
      'SELECT MAX(clock) as max_clock FROM yjs_updates WHERE doc_guid = $1',
      [docGuid]
    );
    return result.rows[0]?.max_clock ?? -1;
  }

  /**
   * Store a Yjs document update — serialized per document so clock order equals
   * causal order by construction (feature 023 R1/FR-001..005).
   *
   * Two composed layers keep clocks causally ordered:
   *  1. **Per-document in-process FIFO queue** (pool-client calls only): the
   *     ENTIRE critical section (transient retry + clock acquisition + insert)
   *     is one queue slot, so two updates issued in production order on this
   *     process get strictly increasing clocks. The transient-failure backoff
   *     that used to live in bindState now runs INSIDE the slot — a retrying
   *     update keeps its queue position instead of re-entering behind later
   *     updates and inverting clocks (the exact bug this kills).
   *  2. **Postgres advisory transaction lock** as the cross-instance
   *     clock-acquisition backstop: MAX+1 + INSERT run in a short transaction
   *     holding `pg_advisory_xact_lock(NS, hashtext(doc_guid))`, so two
   *     instances can never read the same MAX and race. The lock auto-releases
   *     at COMMIT/ROLLBACK.
   *
   * The `ON CONFLICT (doc_guid, clock) DO NOTHING` + MAX+1 retry loop is
   * retained as the mixed-window backstop: during a rolling deploy an old,
   * unserialized pod may still race, and the loop absorbs it with today's exact
   * failure semantics (D-8).
   *
   * @param {string} docGuid - Document GUID
   * @param {Uint8Array} update - Yjs update binary data
   * @param {string|null} userId - User ID who made this update (for version history)
   * @param {string|null} agentName - Agent name if update was made by an AI agent
   * @param {object|null} onBehalfOf - Optional provenance metadata for sync pushes
   *   ({name?, email?, commit?, url?}); persisted to on_behalf_of JSONB (feature
   *   004, D8). Null for every non-sync caller.
   * @param {import('pg').PoolClient|null} externalClient - Optional caller-owned
   *   client (feature 016 claim transaction). When provided, the insert runs on
   *   that client INSIDE the caller's open transaction and the client is NOT
   *   released here; this path BYPASSES the process queue and relies on the
   *   advisory lock alone (taken on the caller's client, held to their COMMIT).
   *   Composition is deadlock-free: the claim takes its agent_edits row lock
   *   before the advisory lock, ordinary writers take only the advisory lock —
   *   a unidirectional order with no cycle (FR-003).
   * @param {object} [opts]
   * @param {boolean|null} [opts.meaningful=null] - write-time meaningful-vs-noise
   *   classification (feature 023 US4). Persisted verbatim in T022; null=unknown
   *   ⇒ meaningful at read time. Never affects persistence success (FR-018).
   * @param {boolean|null} [opts.viaSync=null] - write-time CHANNEL marker
   *   (feature 038 US2). See the via_sync contract on _mapUpdateRow: `true` means
   *   the update arrived on a SYNC_STEP2 catch-up frame; null = unknown ≡
   *   not-sync. Like `meaningful`, it is persisted verbatim and never affects
   *   persistence success.
   * @returns {Promise<number>} The clock value of the stored update
   */
  async storeUpdate(docGuid, update, userId = null, agentName = null, onBehalfOf = null, externalClient = null, { meaningful = null, viaSync = null } = {}) {
    await this._init();

    // External-client (016 claim) path: bypass the process queue; the advisory
    // lock is taken on the caller's open transaction inside _storeUpdateCritical.
    if (externalClient) {
      return this._storeUpdateCritical(externalClient, docGuid, update, userId, agentName, onBehalfOf, meaningful, viaSync, false);
    }

    // Pool-client path: enqueue the whole critical section as one per-doc FIFO
    // slot. `prev.then(run, run)` starts this slot only after the predecessor
    // SETTLES (either outcome) — error isolation so a poisoned slot never wedges
    // later updates (D-9). The caller gets `slot` (the real result/rejection);
    // the map tail is a never-rejecting promise so the next enqueue chains cleanly.
    const prev = this._writeQueues.get(docGuid) || Promise.resolve();
    const run = () => this._runStoreSlot(docGuid, update, userId, agentName, onBehalfOf, meaningful, viaSync);
    const slot = prev.then(run, run);
    const tail = slot.catch(() => {});
    this._writeQueues.set(docGuid, tail);
    // Drop the map entry once this tail settles with no successor enqueued
    // (prevents unbounded growth); a newer slot will have replaced the entry.
    tail.finally(() => {
      if (this._writeQueues.get(docGuid) === tail) this._writeQueues.delete(docGuid);
    });
    return slot;
  }

  /**
   * Run one pool-client write slot: acquire a client, run the critical section
   * with the in-slot transient-failure backoff (3 attempts, exponential +
   * jitter — the constants bindState used before 023), release the client.
   * @private
   */
  async _runStoreSlot(docGuid, update, userId, agentName, onBehalfOf, meaningful, viaSync = null) {
    // The backoff itself is the shared helper (042, FR-015) — same 3 attempts,
    // same jittered exponential delay bindState used before 023.
    const connectFailed = Symbol('connectFailed');
    return retryWithBackoff(async () => {
      // F2: acquire a FRESH client per attempt. A connection that dies mid-INSERT
      // (DB failover/restart, network blip) leaves its pool client permanently
      // unqueryable ("Client has encountered a connection error and is not
      // queryable") — reusing it would make attempts 2-3 fail instantly, defeating
      // the exact backoff meant to ride out a transient DB outage. A new client
      // per attempt restores pre-023 retry semantics. Released on every path,
      // which is why the acquire/release lives INSIDE the retried function.
      //
      // The ACQUIRE itself is not retried (042-review F2): pre-042 a pool-acquire
      // failure — 5s acquire timeout under exhaustion, dead pool — threw straight
      // out of the attempt loop, and retrying it would triple the time a doc's
      // FIFO slot (and the shutdown drain) hangs on an outage without improving
      // the odds the way a fresh attempt at the critical section does.
      let client;
      try {
        client = await this.pool.connect();
      } catch (err) {
        if (err && typeof err === 'object') err[connectFailed] = true;
        throw err;
      }
      try {
        return await this._storeUpdateCritical(client, docGuid, update, userId, agentName, onBehalfOf, meaningful, viaSync, true);
      } finally {
        client.release();
      }
    }, { retryOn: (err) => !(err && err[connectFailed]) });
  }

  /**
   * The clock-acquisition critical section: take the per-doc advisory lock,
   * then MAX+1 + INSERT under the `ON CONFLICT DO NOTHING` mixed-window backstop.
   * When `ownTxn` is true it wraps itself in BEGIN/COMMIT (pool path) and
   * ROLLBACKs on error so the client is clean for the next transient retry; when
   * false the caller owns the transaction (016 claim path) and the advisory lock
   * releases at the caller's COMMIT.
   * @private
   */
  async _storeUpdateCritical(client, docGuid, update, userId, agentName, onBehalfOf, meaningful, viaSync, ownTxn) {
    const MAX_CONFLICT_RETRIES = 5;
    if (ownTxn) await client.query('BEGIN');
    let nextClock;
    try {
      // Cross-instance atomic clock acquisition: serialize MAX+1 + INSERT for
      // this document across every instance (FR-002). Auto-released at COMMIT.
      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [CLOCK_LOCK_NAMESPACE, docGuid]);

      for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
        const clock = await this._getCurrentUpdateClock(client, docGuid);
        nextClock = clock + 1;

        // (feature 023 US6) The write-once-never-read state-vectors table is
        // gone — document birth is just the first yjs_updates row, nothing else.

        // Store the update. ON CONFLICT DO NOTHING => rowCount === 0 only if an
        // unserialized peer claimed this clock (mixed-window backstop, D-8).
        // `meaningful` is persisted verbatim (null = unknown ⇒ meaningful at read,
        // feature 023 US4); it never affects persistence success (FR-018).
        // `via_sync` likewise (feature 038 US2) — one extra bind parameter, no new
        // statements, so the queue/lock/retry/commit semantics above are unchanged.
        const result = await client.query(
          'INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, on_behalf_of, meaningful, via_sync) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (doc_guid, clock) DO NOTHING',
          [docGuid, nextClock, Buffer.from(update), userId, agentName, onBehalfOf == null ? null : JSON.stringify(onBehalfOf), meaningful, viaSync ?? null]
        );

        if (result.rowCount > 0) break; // claimed this clock

        if (attempt === MAX_CONFLICT_RETRIES - 1) {
          throw new Error(`storeUpdate: failed to acquire a unique clock for ${docGuid} after ${MAX_CONFLICT_RETRIES} attempts`);
        }
      }
    } catch (err) {
      if (ownTxn) await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    // F1: the documents.updated_at stamp is advisory metadata — its failure must
    // NEVER be swallowed INSIDE the open transaction. A swallowed error there
    // aborts the transaction (25P02); the subsequent COMMIT then silently
    // executes as ROLLBACK (node-pg does not throw on that), so storeUpdate would
    // return a clock as SUCCESS while the yjs_updates row never committed — silent
    // edit loss. Two paths, both safe:
    if (ownTxn) {
      // Pool path: COMMIT the durable update FIRST, then stamp updated_at AFTER
      // commit as pre-023 advisory metadata. The yjs_updates row is durable
      // regardless of the stamp; a post-commit stamp failure is outside any
      // transaction, so swallowing it here is correct (it can never undo the
      // committed insert or corrupt this returned clock).
      await client.query('COMMIT');
      try {
        await client.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docGuid]);
      } catch (err) {
        console.warn(`Could not update documents.updated_at for ${docGuid} (post-commit, non-fatal):`, err.message);
      }
    } else {
      // External-client (016 claim) path: the caller owns COMMIT, so the stamp
      // must run inside their transaction — but its error must PROPAGATE (never
      // swallow), so a failing stamp rolls the whole claim back cleanly instead
      // of leaving the txn aborted and the caller's next statement failing
      // confusingly.
      await client.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docGuid]);
    }
    return nextClock;
  }

  /**
   * Build a Y.Doc from update rows
   * @private
   * @param {Array} rows - Database rows with update_data column
   * @param {Object} options - Options
   * @param {boolean} [options.gc=true] - Enable garbage collection
   * @returns {Y.Doc} The reconstructed document
   */
  _buildYDocFromRows(rows, options = {}) {
    const { gc = true } = options;
    const ydoc = new Y.Doc({ gc });
    ydoc.transact(() => {
      for (const row of rows) {
        Y.applyUpdate(ydoc, new Uint8Array(row.update_data));
      }
    });
    return ydoc;
  }

  /**
   * First clock value after which the fetched, clock-ordered rows are
   * non-contiguous, or null when gap-free. Contiguity is judged WITHIN the
   * fetched rows only — no assumption about the first clock value
   * (head-of-history edge case). Empty/single-row results are trivially
   * gap-free. Cost: one integer-compare pass over rows already in memory.
   * @private
   */
  _findFirstGap(rows) {
    for (let i = 1; i < rows.length; i++) {
      if (Number(rows[i].clock) !== Number(rows[i - 1].clock) + 1) {
        return Number(rows[i - 1].clock);
      }
    }
    return null;
  }

  /**
   * THE single gap-tolerant choke point every yjs_updates log-rebuild reader
   * funnels through (feature 021 US3 FR-013..016 → generalized in 023 FR-007).
   *
   * Clocks are assigned via MAX+1 races and commits land asynchronously, so a
   * read racing a mid-commit row can see {…k, k+2…} and integrate nothing
   * causally after the gap (observed 2026-07-18: a headings-only skeleton).
   * This runs the caller's clock-ordered SELECT, checks contiguity WITHIN the
   * fetched rows (`_findFirstGap`), and on a gap retries the FULL fetch up to
   * COLLAB_READ_GAP_RETRIES times (default 2) after waits from
   * COLLAB_READ_GAP_RETRY_DELAYS_MS (default 100,300) — ONE shared, bounded
   * budget, no per-path knobs (FR-008). A read still gapped after the budget is
   * returned as-is with a structured warn line tagged `label` (FR-010); the
   * CALLER decides the still-gapped consequence (serve / skip-cache / abort —
   * D-2). Gap-free reads take the plain query path plus one integer pass.
   *
   * Feature 039 (FR-001) adds an OPT-IN tail-completeness check on top of this.
   * `_findFirstGap` only judges contiguity BETWEEN fetched rows, so a read that
   * simply stopped short of a known newest clock looks perfectly gap-free — the
   * torn-read case that froze wrong diffs into the cache. A caller that knows
   * which clock the read must reach passes `expectedTailClock`.
   *
   * ⚠️ NOTE ON THE RETURNED `gapped` FIELD (039 U2): when `expectedTailClock` is
   * supplied, `gapped` means **incomplete** — an interior gap OR a short tail —
   * not strictly "interior gap". The other three callers of this helper
   * (`getYDoc`, `getYDocAtClock`, `_queryUpdatesWithUsers`, and undo/restore
   * through them) never pass the option, so for them `gapped` retains its
   * original meaning exactly. Do not assume the narrow meaning when reading a
   * `gapped` that came from an opted-in call.
   *
   * @param {import('pg').PoolClient} client - open client to query on
   * @param {string} sql - clock-ordered SELECT (must select a `clock` column)
   * @param {Array} params - query parameters
   * @param {string} label - reader tag for the warn line, e.g. `getYDoc <guid>`
   * @param {object} [opts]
   * @param {boolean} [opts.descending=false] - true when `sql` is DESC-ordered
   *   (recentFirst); contiguity is then judged on an ascending view of the rows
   * @param {number} [opts.expectedTailClock] - when supplied, the read is also
   *   incomplete if its newest row is below this clock (or if it returned no
   *   rows at all and this is >= 0). Omit it and behavior is byte-identical to
   *   pre-039, including retry counts and log output (G2).
   * @returns {Promise<{rows: Array, gapped: boolean, retries: number}>}
   * @private
   */
  async _fetchRowsWithGapRetry(client, sql, params, label, { descending = false, expectedTailClock } = {}) {
    // Read PER CALL, deliberately — see readGapRetryEnv.
    const { maxRetries, delays } = readGapRetryEnv();

    // Only meaningful when the caller opted in. `undefined`/`null` ⇒ the tail is
    // never judged, which is what keeps every existing call site byte-identical
    // (G2) — including the backfill's MAX_CLOCK sentinel (G5).
    const checkTail = expectedTailClock !== undefined && expectedTailClock !== null;

    let result;
    let retries = 0;
    let firstGapAfterClock;
    let tailShort = false;
    for (;;) {
      result = await client.query(sql, params);
      const rowsForGap = descending ? [...result.rows].reverse() : result.rows;
      firstGapAfterClock = this._findFirstGap(rowsForGap);
      // Tail check runs on the ASCENDING view, so a DESC-ordered query
      // (recentFirst) is judged on the same axis as the gap check.
      tailShort = checkTail && (
        rowsForGap.length === 0
          ? expectedTailClock >= 0
          : Number(rowsForGap[rowsForGap.length - 1].clock) < expectedTailClock
      );
      const incomplete = firstGapAfterClock !== null || tailShort;
      if (!incomplete || retries >= maxRetries) break;
      const delay = delays.length > 0 ? delays[Math.min(retries, delays.length - 1)] : 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
      retries += 1;
    }

    const incomplete = firstGapAfterClock !== null || tailShort;
    if (incomplete) {
      // FR-010 / G3: never an error, never an unbounded wait — but observable,
      // and now naming WHICH kind of incompleteness so the two causes are
      // distinguishable in production logs (a persistent short tail means a
      // clock that never commits; a persistent gap means a stuck mid-commit row).
      const reason = firstGapAfterClock !== null
        ? (tailShort ? 'gap+short-tail' : 'gap')
        : 'short-tail';
      const tailDetail = checkTail
        ? `, expectedTailClock=${expectedTailClock}, lastClock=${result.rows.length ? Number((descending ? result.rows[0] : result.rows[result.rows.length - 1]).clock) : 'none'}`
        : '';
      console.warn(
        `[Postgres] ${label}: served with clock gap (reason=${reason}, retries=${retries}, rows=${result.rows.length}, firstGapAfterClock=${firstGapAfterClock}${tailDetail})`
      );
    }

    return { rows: result.rows, gapped: incomplete, retries };
  }

  /**
   * Get all updates for a document and reconstruct the Y.Doc.
   *
   * Gap-tolerant via `_fetchRowsWithGapRetry` — the single choke point every
   * log-rebuild reader (history, diffs, exports, MCP read, bindState)
   * funnels through (023 FR-007). Serving-only path: a read still gapped after
   * the budget is served as-is (the log is append-only; the next read heals),
   * with the warn line the fetcher emits.
   *
   * @param {string} docGuid - Document GUID
   * @param {object} [opts]
   * @param {boolean} [opts.withGap=false] - when true, return `{ ydoc, gapped }`
   *   so a stored-artifact caller (restore — 023 FR-009/D-2) can fail closed on a
   *   torn read instead of persisting content derived from a gapped log. Default
   *   keeps the bare-Y.Doc shape every serving-only reader relies on.
   * @returns {Promise<Y.Doc|{ydoc: Y.Doc, gapped: boolean}>} The reconstructed Yjs document
   */
  async getYDoc(docGuid, { withGap = false } = {}) {
    await this._init();

    const client = await this.pool.connect();
    try {
      const queryStart = Date.now();
      const { rows, gapped } = await this._fetchRowsWithGapRetry(
        client,
        'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
        [docGuid],
        `getYDoc ${docGuid}`
      );
      const queryTime = Date.now() - queryStart;

      const applyStart = Date.now();
      const ydoc = this._buildYDocFromRows(rows);
      const applyTime = Date.now() - applyStart;

      if (rows.length > 0) {
        const totalBytes = rows.reduce((sum, r) => sum + r.update_data.length, 0);
        console.log(`[Postgres] getYDoc ${docGuid}: ${rows.length} updates, ${totalBytes} bytes, query=${queryTime}ms, apply=${applyTime}ms`);
      }

      return withGap ? { ydoc, gapped } : ydoc;
    } finally {
      client.release();
    }
  }

  /**
   * Clear all data for a specific document
   * @param {string} docGuid - Document GUID
   * @returns {Promise<void>}
   */
  async clearDocument(docGuid) {
    await this._init();

    const client = await this.pool.connect();
    try {
      await client.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
    } finally {
      client.release();
    }

    // Feature 045 review (LOW-4): every row for this guid is gone and its clocks
    // restart at 0, so a still-connected client writing under the same guid
    // would otherwise be answered from the DEAD document's memoized outcomes.
    // Display-only cache, dropped after the delete succeeded; a failure here
    // must never turn a completed deletion into an error.
    try {
      resupplyResolution.clearDoc(docGuid);
    } catch (err) {
      console.warn(`[PostgresPersistence] resupply cache clear failed for ${docGuid}:`, err.message);
    }
  }

  /**
   * Clear all data from the database.
   * SAFETY: Only allowed on databases whose name contains "test".
   * This prevents accidental data loss in development or production.
   * @returns {Promise<void>}
   */
  async clearAll() {
    if (!this._dbName || !this._dbName.includes('test')) {
      throw new Error(
        `clearAll() refused: database "${this._dbName}" does not appear to be a test database. ` +
        'This method only runs against databases with "test" in the name to prevent accidental data loss.'
      );
    }

    await this._init();

    const client = await this.pool.connect();
    try {
      await client.query('DELETE FROM yjs_updates');
    } finally {
      client.release();
    }
  }

  /**
   * Get a list of all document GUIDs in the database.
   *
   * CONSUMERS (feature 042, DEC-2 — looks unused from `server/`, is not):
   * `getAllDocumentsWithMeta` below, and the integration-test harness
   * (`__tests__/integration/collaboration.test.js`). Do not delete as dead.
   *
   * @returns {Promise<Array<{docGuid: string, updatedAt: Date}>>}
   */
  async getAllDocuments() {
    await this._init();
    
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT DISTINCT doc_guid, MAX(created_at) as updated_at
        FROM yjs_updates
        GROUP BY doc_guid
        ORDER BY updated_at DESC
      `);
      
      return result.rows.map(row => ({
        docGuid: row.doc_guid,
        updatedAt: row.updated_at
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get document metadata (title) by extracting it from the Yjs document.
   *
   * CONSUMERS (feature 042, DEC-2 — this is a MIGRATION ABI, not dead code):
   * the shipped migration `migrations/1766103664104_add-title-to-documents.js`
   * requires this module and calls this method, and `globalSetup.js` runs
   * `npm run migrate` before every backend test run — so removing or moving it
   * breaks the whole suite, not just a replay from scratch. Also
   * `script/backfill-document-titles.js` and `server/__tests__/document-titles.test.js`.
   *
   * @param {string} docGuid - Document GUID
   * @returns {Promise<{title: string|null}>}
   */
  async getDocumentMeta(docGuid) {
    try {
      const ydoc = await this.getYDoc(docGuid);
      const meta = ydoc.getMap('meta');
      const title = meta.get('title') || null;
      return { title };
    } catch (error) {
      return { title: null };
    }
  }

  /**
   * Update the denormalized title in the documents table
   * This keeps the title in sync for fast list queries
   * @param {string} docGuid - Document GUID
   * @param {string|null} title - New title value
   * @returns {Promise<void>}
   */
  async updateDocumentTitle(docGuid, title) {
    await this._init();
    const client = await this.pool.connect();
    try {
      await client.query(
        'UPDATE documents SET title = $1 WHERE id = $2',
        [title, docGuid]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Get all documents with their metadata (title, updatedAt).
   *
   * CONSUMERS (feature 042, DEC-2): the integration-test harness only — no
   * production caller. Kept deliberately; do not delete as dead.
   *
   * @returns {Promise<Array<{docGuid: string, title: string|null, updatedAt: Date}>>}
   */
  async getAllDocumentsWithMeta() {
    const docs = await this.getAllDocuments();
    
    // Fetch metadata for each document in parallel
    const docsWithMeta = await Promise.all(
      docs.map(async (doc) => {
        const meta = await this.getDocumentMeta(doc.docGuid);
        return {
          docGuid: doc.docGuid,
          title: meta.title,
          updatedAt: doc.updatedAt
        };
      })
    );
    
    return docsWithMeta;
  }

  // ==================== Version History Methods ====================

  /**
   * Transform a database row to an update object
   * @private
   */
  _mapUpdateRow(row, includeData = false) {
    const result = {
      clock: row.clock,
      createdAt: row.created_at,
      userId: row.user_id,
      userName: row.user_name,
      userEmail: row.user_email,
      userPicture: row.user_picture,
      agentName: row.agent_name,
      // on-behalf-of provenance for sync pushes (feature 004, D8); null otherwise
      onBehalfOf: row.on_behalf_of != null ? row.on_behalf_of : null,
      // Write-time meaningful classification (feature 023 US4); null = unknown
      // ⇒ every reader treats it as meaningful (D-3). undefined when unselected.
      meaningful: row.meaningful ?? null,
      // ── via_sync CONTRACT (feature 038 US2, FR-015) ────────────────────────
      // A via_sync row proves the content reached the server THROUGH that
      // client — never that the client WROTE it. It records the CHANNEL, not a
      // verdict on authorship: `true` means the update was produced while a
      // SYNC_STEP2 catch-up frame was being applied. Attribution (userId /
      // agentName) on a flagged row is unchanged and still correct as TRANSPORT
      // attribution — a genuine offline edit synced on reconnect is that user's
      // work and stays theirs.
      //
      // Uniform read rule: ONLY `true` means sync. `null` (every pre-feature
      // row — there is no backfill, D1 — and every non-step2 write) and `false`
      // are identical, "not known to be sync". Never treat `null` as suspicious.
      //
      // Consumer obligations: undo (server/undo/legacy.js) treats a flagged row
      // as foreign to an identity run — it breaks the run, and the honest
      // refusal is preferred over stitching across a re-supply (D2); the collab
      // guardrail ANNOTATES sync-sourced triggers without changing whether a
      // page fires (D3). undefined when the column is unselected ⇒ null.
      //
      // Feature 045 added a third consumer class: DISPLAY RESOLUTION. Every
      // author-displaying surface now refuses to present a flagged row's stamped
      // identity as the AUTHORSHIP of that row's content — it recovers the true
      // author from the payload's embedded Yjs client identities via
      // `server/resupply-resolution.js`, or shows the honest "Synced content"
      // entry. That resolution is display-only: it never rewrites this row, never
      // feeds replay/undo/permissions/restore/diff (045 FR-010), and does not
      // change what the stamp MEANS here — transport attribution, as 038 defined.
      viaSync: row.via_sync ?? null,
    };
    if (includeData && row.update_data) {
      result.updateData = new Uint8Array(row.update_data);
    }
    return result;
  }

  /**
   * Query updates with user info (consolidated query method)
   * @private
   * @param {string} docGuid - Document GUID
   * @param {Object} options - Query options
   * @param {number} [options.clockStart] - Starting clock value (inclusive)
   * @param {number} [options.clockEnd] - Ending clock value (inclusive)
   * @param {number} [options.limit] - Maximum number of updates to return
   * @param {boolean} [options.includeData] - Include update_data in results
   * @param {boolean} [options.recentFirst] - Query DESC and reverse (for efficient "last N" queries)
   * @returns {Promise<{updates: Array, gapped: boolean}>} Updates with user
   *   metadata in ascending clock order, plus the gap indicator from the
   *   shared choke point. INTERNAL return shape: the public wrappers keep their
   *   array shape (A1 — an array-attached `gapped` would die in callers' `.map`,
   *   so gapped is surfaced only to the callers that produce artifacts).
   */
  async _queryUpdatesWithUsers(docGuid, options = {}) {
    const { clockStart, clockEnd, limit, includeData = false, recentFirst = false } = options;

    await this._init();
    const client = await this.pool.connect();
    try {
      const dataColumn = includeData ? 'u.update_data, ' : '';
      let whereClause = 'WHERE u.doc_guid = $1';
      const params = [docGuid];

      if (clockStart !== undefined && clockEnd !== undefined) {
        whereClause += ` AND u.clock >= $${params.length + 1} AND u.clock <= $${params.length + 2}`;
        params.push(clockStart, clockEnd);
      }

      let orderClause = 'ORDER BY u.clock ASC';
      let limitClause = '';
      const descending = recentFirst && !!limit;

      if (descending) {
        // Query DESC with limit, then reverse for ascending order.
        orderClause = 'ORDER BY u.clock DESC';
        limitClause = `LIMIT $${params.length + 1}`;
        params.push(limit);
      }

      const sql = `SELECT u.clock, ${dataColumn}u.created_at, u.user_id, u.agent_name, u.on_behalf_of, u.meaningful, u.via_sync,
                usr.name as user_name, usr.email as user_email, usr.picture as user_picture
         FROM yjs_updates u
         LEFT JOIN users usr ON u.user_id = usr.id
         ${whereClause}
         ${orderClause}
         ${limitClause}`;

      // Funnel through the shared gap-tolerant choke point (023 FR-007).
      const { rows: rawRows, gapped } = await this._fetchRowsWithGapRetry(
        client, sql, params, `_queryUpdatesWithUsers ${docGuid}`, { descending }
      );

      const rows = descending ? [...rawRows].reverse() : rawRows;
      return { updates: rows.map(row => this._mapUpdateRow(row, includeData)), gapped };
    } finally {
      client.release();
    }
  }

  /**
   * Get updates in a clock range with user info.
   * @param {string} docGuid - Document GUID
   * @param {number} clockStart - Starting clock value (inclusive)
   * @param {number} clockEnd - Ending clock value (inclusive)
   * @param {object} [opts]
   * @param {boolean} [opts.withGap=false] - when true, return
   *   `{ updates, gapped }` so an artifact-producing caller (undo loadLog) can
   *   refuse to freeze a torn read (D-2). Default keeps the array shape.
   * @param {boolean} [opts.includeData=true] - when false, the `update_data`
   *   blob column is left out of the projection and rows carry no `updateData`.
   *   Feature 042 (FR-015): the metadata-only callers (the version-history
   *   drill-down and the single-row lookup in `getContentAtClock`) were pulling
   *   every update's payload over the wire and discarding it a line later.
   *   Defaults to TRUE so every un-migrated call site is unchanged.
   * @returns {Promise<Array|{updates: Array, gapped: boolean}>}
   */
  async getUpdatesInRange(docGuid, clockStart, clockEnd, { withGap = false, includeData = true } = {}) {
    const { updates, gapped } = await this._queryUpdatesWithUsers(docGuid, { clockStart, clockEnd, includeData });
    return withGap ? { updates, gapped } : updates;
  }

  /**
   * The document's clock range, without materializing its update log.
   *
   * Feature 042 (FR-009): both version-history range checks used to load the
   * entire user-joined log purely to take a min and a max of the clock column.
   * On a long-lived document that is an O(rows) read (with the JOIN, and with
   * the gap-retry budget) to answer a question Postgres answers from the index.
   *
   * `MIN`/`MAX` over an empty set is SQL `NULL` in a SINGLE row, not zero rows,
   * so emptiness is tested on the VALUE. Callers must fire their "no version
   * history" branch on a null before formatting any range — the numbers here
   * interpolate verbatim into user-visible error strings.
   *
   * @param {string} docGuid - Document GUID
   * @returns {Promise<{minClock: number|null, maxClock: number|null}>}
   */
  async getClockRange(docGuid) {
    await this._init();
    const result = await this.pool.query(
      'SELECT MIN(clock)::int AS min_clock, MAX(clock)::int AS max_clock FROM yjs_updates WHERE doc_guid = $1',
      [docGuid]
    );
    const row = result.rows[0] || {};
    return {
      minClock: row.min_clock ?? null,
      maxClock: row.max_clock ?? null,
    };
  }

  // ── Resupply-resolution readers (feature 045) ─────────────────────────────
  // Three narrow READ-ONLY queries behind `server/resupply-resolution.js`, the
  // one place that decides who authored the content in a `via_sync` row. They
  // exist as first-class methods (rather than the resolver holding a pool)
  // because the resolver depends on an INTERFACE — tests hand it a fake — and
  // because none of them wants the users JOIN or the gap-retry budget of
  // `_queryUpdatesWithUsers`.

  /**
   * Payloads for the rows being resolved, by primary key.
   *
   * Deliberately NOT routed through `_queryUpdatesWithUsers`: no `users` join is
   * needed, and the gap-retry budget at that shared choke point exists for log
   * REBUILDS (023 FR-007), where a missing interior row corrupts the result.
   * Resolution is not a rebuild — a row this query cannot see simply leaves one
   * target unresolved, which renders as the honest "Synced content" entry. Paying
   * the retry budget to sharpen a display hint would be the wrong trade.
   *
   * @param {string} docGuid - Document GUID
   * @param {number[]} clocks - Clock values to fetch (the PK's second column)
   * @returns {Promise<Array<{clock: number, updateData: Uint8Array}>>} ascending;
   *   empty input returns `[]` WITHOUT querying.
   */
  async getUpdatePayloads(docGuid, clocks) {
    if (!Array.isArray(clocks) || clocks.length === 0) return [];
    await this._init();
    const result = await this.pool.query(
      'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 AND clock = ANY($2::int[]) ORDER BY clock',
      [docGuid, clocks]
    );
    return result.rows.map(row => ({
      clock: row.clock,
      updateData: row.update_data ? new Uint8Array(row.update_data) : null,
    }));
  }

  /**
   * The evidence batch reader: a document's DIRECTLY-attributed rows, ascending.
   *
   * `via_sync IS NOT TRUE` is the exact 038 read rule restated at a second read
   * site: ONLY `true` means sync; `NULL` (every pre-038 row, and every non-step2
   * write) and `false` are identical, "not known to be sync", and are never
   * treated as suspicious. A relayed row is excluded because it may not serve as
   * evidence for another relayed row (045 FR-006) — that is what makes a chain of
   * relays unable to launder a relayer into "evidence". `user_id IS NOT NULL`
   * because an unattributed row proves nothing about who a client identity is.
   *
   * @param {string} docGuid - Document GUID
   * @param {object} opts
   * @param {number} opts.afterClock - exclusive lower bound (the fold's high-water mark)
   * @param {number} opts.beforeClock - exclusive upper bound (evidence is strictly PRIOR)
   * @param {number} opts.limit - batch size
   * @returns {Promise<Array<{clock, userId, agentName, updateData}>>} ascending clock
   */
  async getDirectAttributedRows(docGuid, { afterClock = -1, beforeClock, limit = 500 } = {}) {
    await this._init();
    const result = await this.pool.query(
      `SELECT clock, user_id, agent_name, update_data
         FROM yjs_updates
        WHERE doc_guid = $1
          AND clock > $2
          AND clock < $3
          AND via_sync IS NOT TRUE
          AND user_id IS NOT NULL
        ORDER BY clock ASC
        LIMIT $4`,
      [docGuid, afterClock, beforeClock, limit]
    );
    return result.rows.map(row => ({
      clock: row.clock,
      userId: row.user_id,
      agentName: row.agent_name,
      updateData: row.update_data ? new Uint8Array(row.update_data) : null,
    }));
  }

  /**
   * Display fields for resolved user ids the caller's own rows do not carry.
   *
   * A resolved id ABSENT from the result is the deleted-account signal (045
   * RBD-045-11): the identity was determined, the account is gone, so the surface
   * renders `UNKNOWN_AUTHOR` rather than inventing a name.
   *
   * @param {string[]} ids - user ids
   * @returns {Promise<Map<string, {userName, userEmail, userPicture}>>}
   */
  async getUserDisplayFields(ids) {
    const out = new Map();
    if (!Array.isArray(ids) || ids.length === 0) return out;
    await this._init();
    const result = await this.pool.query(
      'SELECT id, name, email, picture FROM users WHERE id = ANY($1::uuid[])',
      [ids]
    );
    for (const row of result.rows) {
      out.set(row.id, { userName: row.name, userEmail: row.email, userPicture: row.picture });
    }
    return out;
  }

  /**
   * Get recent updates with user info (limited query for metadata)
   * @param {string} docGuid - Document GUID
   * @param {number} limit - Maximum number of updates to return (default: 100)
   * @returns {Promise<Array>} Recent updates with user metadata in ascending clock order
   */
  async getRecentUpdatesWithUsers(docGuid, limit = 100) {
    const { updates } = await this._queryUpdatesWithUsers(docGuid, { limit, recentFirst: true });
    return updates;
  }

  /**
   * Get all updates with user info for version timeline
   * @param {string} docGuid - Document GUID
   * @returns {Promise<Array>} All updates with user metadata
   */
  async getUpdatesWithUsers(docGuid) {
    const { updates } = await this._queryUpdatesWithUsers(docGuid);
    return updates;
  }

  /**
   * Reconstruct Y.Doc at a specific clock value. Gap-tolerant via the shared
   * choke point (023 FR-007); serving-only path — a read still gapped after the
   * budget is served as-is with the fetcher's warn line (version preview never
   * freezes an artifact — D-2).
   * @param {string} docGuid - Document GUID
   * @param {number} clock - Clock value to reconstruct up to
   * @param {object} [opts]
   * @param {boolean} [opts.withGap=false] - when true, return `{ ydoc, gapped }`
   *   so a stored-artifact caller (restore — 023 FR-009/D-2) can fail closed on a
   *   torn read. Default keeps the bare-Y.Doc serving-only shape.
   * @param {number} [opts.expectedTailClock] - the clock this read MUST reach to
   *   count as complete (039 FR-003, extended here by feature 041 FR-012).
   *   Without it, `gapped` only ever meant "interior gap": a read that stopped
   *   SHORT of the target — rows at the tail not yet visible — looked complete,
   *   which put a hole in restore's fail-closed guarantee (it would restore to
   *   an earlier state while labelling the row with the requested version).
   *
   *   ⚠️ NEVER DERIVE THIS FROM `clock` — same caution as `getUpdateRowsUpTo`:
   *   `clock` is not always a real version (sentinel MAX_CLOCK "whole log" reads
   *   exist), so defaulting it would make those reads permanently "incomplete".
   *   Only a caller that has validated it is asking for a committed version may
   *   pass this; serving-only readers (previews, compare) must not.
   * @returns {Promise<Y.Doc|{ydoc: Y.Doc, gapped: boolean}>} Document state at that clock
   */
  async getYDocAtClock(docGuid, clock, { withGap = false, expectedTailClock } = {}) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const { rows, gapped } = await this._fetchRowsWithGapRetry(
        client,
        'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 AND clock <= $2 ORDER BY clock ASC',
        [docGuid, clock],
        `getYDocAtClock ${docGuid}@${clock}`,
        { expectedTailClock }
      );
      const ydoc = this._buildYDocFromRows(rows);
      return withGap ? { ydoc, gapped } : ydoc;
    } finally {
      client.release();
    }
  }

  /**
   * Fetch the raw clock-ordered update rows up to `clock` for the diff service,
   * gap-tolerant via the shared choke point, surfacing the `gapped` indicator so
   * the diff service can serve the computed diff but SKIP the cache write on a
   * torn read (023 FR-009, D-2). Returns rows with `clock` + `update_data`.
   * @param {string} docGuid - Document GUID
   * @param {number} clock - Upper clock bound (inclusive)
   * @param {object} [opts]
   * @param {number} [opts.expectedTailClock] - the clock this read MUST reach to
   *   count as complete (039 FR-003). Forwarded to `_fetchRowsWithGapRetry`;
   *   `gapped` then means "incomplete" (interior gap OR short tail).
   *
   *   ⚠️ NEVER DERIVE THIS FROM `clock` (CD-5 / G5). It is opt-in precisely
   *   because `clock` is not always a real version:
   *   `server/scripts/backfill-meaningful-classification.js:100` calls
   *   `getUpdateRowsUpTo(docGuid, MAX_CLOCK)` with the sentinel
   *   `MAX_CLOCK = 2147483647` to mean "the whole log". Defaulting
   *   `expectedTailClock` to `clock` would make that read permanently
   *   "incomplete", burning the full retry budget on EVERY document and logging
   *   a false incomplete-read warning for each one. Only a caller that knows it
   *   is asking for a specific committed version may pass this.
   * @returns {Promise<{rows: Array, gapped: boolean}>}
   */
  async getUpdateRowsUpTo(docGuid, clock, { expectedTailClock } = {}) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const { rows, gapped } = await this._fetchRowsWithGapRetry(
        client,
        'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 AND clock <= $2 ORDER BY clock ASC',
        [docGuid, clock],
        `getUpdateRowsUpTo ${docGuid}@${clock}`,
        { expectedTailClock }
      );
      return { rows, gapped };
    } finally {
      client.release();
    }
  }

  /**
   * Get the total number of updates for a document
   * @param {string} docGuid - Document GUID
   * @returns {Promise<number>} Total update count
   */
  async getUpdateCount(docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT COUNT(*) as count FROM yjs_updates WHERE doc_guid = $1',
        [docGuid]
      );
      return parseInt(result.rows[0].count, 10);
    } finally {
      client.release();
    }
  }

  /**
   * Get named versions for a document
   * @param {string} docGuid - Document GUID
   * @returns {Promise<Array>} Named versions
   */
  async getNamedVersions(docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      // Join with yjs_updates to get the original timestamp of the clock_end update
      const result = await client.query(
        `SELECT v.*, u.name as creator_name, u.email as creator_email, u.picture as creator_picture,
                upd.created_at as original_timestamp
         FROM document_versions v
         LEFT JOIN users u ON v.created_by = u.id
         LEFT JOIN yjs_updates upd ON upd.doc_guid = v.doc_id AND upd.clock = v.clock_end
         WHERE v.doc_id = $1
         ORDER BY v.clock_end DESC`,
        [docGuid]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Create a named version — a PURE clock-range label (feature 023 US3, FR-011).
   * No content snapshot is built or stored: version content is ALWAYS the replay
   * of the update log to clock_end under the gap-tolerant read path, so named-
   * version creation can no longer freeze a bad/gapped read as truth.
   * @param {string} docGuid - Document GUID
   * @param {number} clockStart - Starting clock
   * @param {number} clockEnd - Ending clock
   * @param {string|null} name - Version name (null for auto-generated)
   * @param {string|null} userId - User who created this version
   * @returns {Promise<Object>} Created version
   */
  async createNamedVersion(docGuid, clockStart, clockEnd, name, userId) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO document_versions (doc_id, name, clock_start, clock_end, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [docGuid, name, clockStart, clockEnd, userId]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Update a named version. Doc-scoped: the UPDATE only touches a row whose
   * doc_id matches, so a versionId from another document is a no-op (returns
   * undefined) — the 019 cross-doc leak class is impossible at the SQL layer (F7).
   * @param {string} versionId - Version ID
   * @param {string} name - New version name
   * @param {string} docGuid - Owning document GUID (scope guard)
   * @returns {Promise<Object>} Updated version (undefined if no doc-scoped match)
   */
  async updateVersionName(versionId, name, docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'UPDATE document_versions SET name = $1 WHERE id = $2 AND doc_id = $3 RETURNING *',
        [name, versionId, docGuid]
      );
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * Delete a named version. Doc-scoped (F7): a versionId from another document
   * deletes nothing and returns false.
   * @param {string} versionId - Version ID
   * @param {string} docGuid - Owning document GUID (scope guard)
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteNamedVersion(versionId, docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'DELETE FROM document_versions WHERE id = $1 AND doc_id = $2',
        [versionId, docGuid]
      );
      return result.rowCount > 0;
    } finally {
      client.release();
    }
  }

  /**
   * Get a named version by ID. Doc-scoped (F7): a versionId belonging to another
   * document returns null, making the 019 cross-doc read leak impossible at the
   * SQL layer regardless of any caller-side check.
   * @param {string} versionId - Version ID
   * @param {string} docGuid - Owning document GUID (scope guard)
   * @returns {Promise<Object|null>} Version or null
   */
  async getVersionById(versionId, docGuid) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT v.*, u.name as creator_name, u.email as creator_email, u.picture as creator_picture
         FROM document_versions v
         LEFT JOIN users u ON v.created_by = u.id
         WHERE v.id = $1 AND v.doc_id = $2`,
        [versionId, docGuid]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Trivial reachability probe for GET /ready (feature 010, US4). Acquires a
   * connection, runs `SELECT 1` under a short timeout, and releases the
   * connection immediately — it must never hold a pool connection past the
   * check (Edge Cases). Rejects (or resolves false) if Postgres is unreachable
   * or slow.
   * @param {number} [timeoutMs=2000] - overall deadline for the probe
   * @returns {Promise<boolean>} true when Postgres answered within the deadline
   */
  async ping(timeoutMs = 2000) {
    let timer;
    try {
      // Use pool.query (not pool.connect + manual release): it acquires a client,
      // runs the query, and ALWAYS releases the client back to the pool when the
      // query settles — even if our timeout below has already fired and we've
      // returned false. The previous connect()+race leaked a client whenever
      // connect() resolved AFTER the timeout rejected (a 2s–5s window), and it
      // released while SELECT 1 was still in flight on the slow path; under an
      // unauthenticated, probe-hammered /ready that exhausted DB_POOL_MAX in
      // minutes. Racing the query promise (not the client) against the deadline
      // keeps readiness fast (datastore-down ⇒ 503 within ~timeoutMs) with no
      // client held past the check on any path.
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ping timeout')), timeoutMs);
      });
      await Promise.race([this.pool.query('SELECT 1'), timeout]);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Close the database connection pool
   * @returns {Promise<void>}
   */
  async destroy() {
    await this.pool.end();
  }

  /**
   * Get the database connection pool
   * Useful for sharing the pool with other modules (e.g., auth)
   * @returns {Pool}
   */
  getPool() {
    return this.pool;
  }
}

module.exports = { PostgresPersistence };

