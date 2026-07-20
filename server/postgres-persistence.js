const { Pool } = require('pg');
const Y = require('yjs');

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
    const poolConfig = {
      ...baseConfig,
      max: Number(process.env.DB_POOL_MAX ?? 20),
      connectionTimeoutMillis: Number(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS ?? 5000),
    };
    if (opts.statementTimeout !== false) {
      poolConfig.statement_timeout = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30000);
    }
    this.pool = new Pool(poolConfig);

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
   * @returns {Promise<number>} The clock value of the stored update
   */
  async storeUpdate(docGuid, update, userId = null, agentName = null, onBehalfOf = null, externalClient = null, { meaningful = null } = {}) {
    await this._init();

    // External-client (016 claim) path: bypass the process queue; the advisory
    // lock is taken on the caller's open transaction inside _storeUpdateCritical.
    if (externalClient) {
      return this._storeUpdateCritical(externalClient, docGuid, update, userId, agentName, onBehalfOf, meaningful, false);
    }

    // Pool-client path: enqueue the whole critical section as one per-doc FIFO
    // slot. `prev.then(run, run)` starts this slot only after the predecessor
    // SETTLES (either outcome) — error isolation so a poisoned slot never wedges
    // later updates (D-9). The caller gets `slot` (the real result/rejection);
    // the map tail is a never-rejecting promise so the next enqueue chains cleanly.
    const prev = this._writeQueues.get(docGuid) || Promise.resolve();
    const run = () => this._runStoreSlot(docGuid, update, userId, agentName, onBehalfOf, meaningful);
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
  async _runStoreSlot(docGuid, update, userId, agentName, onBehalfOf, meaningful) {
    const MAX_ATTEMPTS = 3;
    const baseDelay = 100;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // F2: acquire a FRESH client per attempt. A connection that dies mid-INSERT
      // (DB failover/restart, network blip) leaves its pool client permanently
      // unqueryable ("Client has encountered a connection error and is not
      // queryable") — reusing it would make attempts 2-3 fail instantly, defeating
      // the exact backoff meant to ride out a transient DB outage. A new client
      // per attempt restores pre-023 retry semantics. Released on every path.
      const client = await this.pool.connect();
      try {
        return await this._storeUpdateCritical(client, docGuid, update, userId, agentName, onBehalfOf, meaningful, true);
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) throw err;
        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 50;
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        client.release();
      }
    }
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
  async _storeUpdateCritical(client, docGuid, update, userId, agentName, onBehalfOf, meaningful, ownTxn) {
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
        const result = await client.query(
          'INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, on_behalf_of, meaningful) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (doc_guid, clock) DO NOTHING',
          [docGuid, nextClock, Buffer.from(update), userId, agentName, onBehalfOf == null ? null : JSON.stringify(onBehalfOf), meaningful]
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
   * @param {import('pg').PoolClient} client - open client to query on
   * @param {string} sql - clock-ordered SELECT (must select a `clock` column)
   * @param {Array} params - query parameters
   * @param {string} label - reader tag for the warn line, e.g. `getYDoc <guid>`
   * @param {object} [opts]
   * @param {boolean} [opts.descending=false] - true when `sql` is DESC-ordered
   *   (recentFirst); contiguity is then judged on an ascending view of the rows
   * @returns {Promise<{rows: Array, gapped: boolean, retries: number}>}
   * @private
   */
  async _fetchRowsWithGapRetry(client, sql, params, label, { descending = false } = {}) {
    const maxRetriesRaw = parseInt(process.env.COLLAB_READ_GAP_RETRIES, 10);
    const maxRetries = Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0 ? maxRetriesRaw : 2;
    const delays = (process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS || '100,300')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0);

    let result;
    let retries = 0;
    let firstGapAfterClock;
    for (;;) {
      result = await client.query(sql, params);
      const rowsForGap = descending ? [...result.rows].reverse() : result.rows;
      firstGapAfterClock = this._findFirstGap(rowsForGap);
      if (firstGapAfterClock === null || retries >= maxRetries) break;
      const delay = delays.length > 0 ? delays[Math.min(retries, delays.length - 1)] : 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
      retries += 1;
    }

    if (firstGapAfterClock !== null) {
      // FR-010: never an error, never an unbounded wait — but observable.
      console.warn(
        `[Postgres] ${label}: served with clock gap (retries=${retries}, rows=${result.rows.length}, firstGapAfterClock=${firstGapAfterClock})`
      );
    }

    return { rows: result.rows, gapped: firstGapAfterClock !== null, retries };
  }

  /**
   * Get all updates for a document and reconstruct the Y.Doc.
   *
   * Gap-tolerant via `_fetchRowsWithGapRetry` — the single choke point every
   * log-rebuild reader (history, diffs, exports, MCP read, getDiff/bindState)
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
   * Get the diff (updates) needed to sync a document from a given state vector
   * @param {string} docGuid - Document GUID
   * @param {Uint8Array} stateVector - State vector to diff against
   * @returns {Promise<Uint8Array>} The encoded update containing the diff
   */
  async getDiff(docGuid, stateVector) {
    const ydoc = await this.getYDoc(docGuid);
    return Y.encodeStateAsUpdate(ydoc, stateVector);
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
   * Get a list of all document GUIDs in the database
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
   * Get document metadata (title) by extracting it from the Yjs document
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
   * Get all documents with their metadata (title, updatedAt)
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

      const sql = `SELECT u.clock, ${dataColumn}u.created_at, u.user_id, u.agent_name, u.on_behalf_of, u.meaningful,
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
   * @returns {Promise<Array|{updates: Array, gapped: boolean}>}
   */
  async getUpdatesInRange(docGuid, clockStart, clockEnd, { withGap = false } = {}) {
    const { updates, gapped } = await this._queryUpdatesWithUsers(docGuid, { clockStart, clockEnd, includeData: true });
    return withGap ? { updates, gapped } : updates;
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
   * @returns {Promise<Y.Doc|{ydoc: Y.Doc, gapped: boolean}>} Document state at that clock
   */
  async getYDocAtClock(docGuid, clock, { withGap = false } = {}) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const { rows, gapped } = await this._fetchRowsWithGapRetry(
        client,
        'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 AND clock <= $2 ORDER BY clock ASC',
        [docGuid, clock],
        `getYDocAtClock ${docGuid}@${clock}`
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
   * @returns {Promise<{rows: Array, gapped: boolean}>}
   */
  async getUpdateRowsUpTo(docGuid, clock) {
    await this._init();
    const client = await this.pool.connect();
    try {
      const { rows, gapped } = await this._fetchRowsWithGapRetry(
        client,
        'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 AND clock <= $2 ORDER BY clock ASC',
        [docGuid, clock],
        `getUpdateRowsUpTo ${docGuid}@${clock}`
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

