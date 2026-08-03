/**
 * Version History Business Logic
 * Handles version grouping, timeline generation, and restore operations
 */

const Y = require('yjs');
const { ORIGIN_RESTORE } = require('./origin');
const { extractXml, replaceFragmentContents } = require('./yjs-utils');
const editRecords = require('./undo/edit-records');
const { applyLiveUpdate } = require('./live-apply');
const { isTrustedLiveDoc, untrustedReason } = require('./live-doc-trust');
const { resolveForRows, EMPTY_RESOLUTION } = require('./resupply-resolution');

/**
 * Thrown when a requested version cannot be resolved: an unknown/foreign named
 * version id, an unparseable version id, or a clock outside the document's
 * range. Callers map `instanceof VersionNotFoundError` to HTTP 404 (F6) — the
 * previous `error.message === 'Version not found'` string checks never matched
 * the descriptive out-of-range message, so those turned into 500s. The message
 * stays descriptive for MCP callers that surface it to the model.
 */
class VersionNotFoundError extends Error {
  constructor(message = 'Version not found') {
    super(message);
    this.name = 'VersionNotFoundError';
  }
}

/**
 * Thrown when a restore would build its stored artifacts (the restore update row
 * + the agent_edits record) from a read that is still gapped after the shared
 * retry budget (feature 023 FR-009, D-2). Restore is the one stored-artifact path
 * that must fail CLOSED on a torn log — the same fail-closed posture undo uses —
 * rather than persist content derived from a non-contiguous read. REST maps this
 * to HTTP 503; the MCP surface surfaces the message as a teaching error so the
 * model retries. Never raised on serving-only reads (previews/diffs serve as-is).
 */
class DocumentSyncingError extends Error {
  constructor(message = 'The document is still syncing — retry in a moment.') {
    super(message);
    this.name = 'DocumentSyncingError';
  }
}

// Default inactivity threshold for grouping updates into versions (5 minutes)
const DEFAULT_INACTIVITY_THRESHOLD = 5 * 60 * 1000;

// Inactivity threshold for grouping individual updates within a version (10 seconds)
const UPDATE_GROUPING_THRESHOLD = 10 * 1000;

// Max distinct on-behalf-of identities surfaced per version before overflowing
// into a "+N more" count (feature 004, D8; review note #5 — keeps a
// high-frequency CI pusher from accreting an unbounded array in the timeline).
const MAX_ONBEHALFOF_IDENTITIES = 10;

/**
 * Generate a deterministic color from a user ID
 * @param {string} id - User ID
 * @returns {string} HSL color string
 */
function generateColorFromId(id) {
  if (!id) return '#888888';
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

/**
 * Create a consistent author key for color generation
 * Agents get a distinct key from their user to have different colors
 * @param {string} userId - User ID
 * @param {string|null} agentName - Agent name if this is an agent edit
 * @returns {string} Author key for color generation
 */
function getAuthorKey(userId, agentName) {
  return agentName ? `${userId}-agent-${agentName}` : userId;
}

/**
 * The synthetic contributor shown for update rows that carry no user
 * attribution (feature 040, FR-008, D4).
 *
 * Such rows are real history — most often edits by a user who has since
 * deleted their account, since `yjs_updates.user_id` is `ON DELETE SET NULL`
 * precisely so a document's history survives its contributors (see the
 * FK-policy note in server/undo/edit-records.js). Before this feature those
 * rows were simply skipped, so a version built entirely from them rendered an
 * EMPTY contributor list — which reads as "nobody edited this", a silent lie
 * about a version that demonstrably exists.
 *
 * `color` is the stable neutral, matching the client's no-id fallback, so the
 * entry looks identical on any day (FR-010).
 */
const UNKNOWN_AUTHOR = Object.freeze({
  id: null,
  name: 'Unknown author',
  email: null,
  picture: null,
  color: '#888888',
  isAgent: false,
});

/** Fixed map key for UNKNOWN_AUTHOR, so repeated unattributed rows COLLAPSE
 * into exactly one entry per version instead of one entry per row. */
const UNKNOWN_AUTHOR_KEY = 'unknown';

/**
 * The synthetic contributor shown for sync-relayed content whose true author
 * cannot be derived (feature 045, FR-004).
 *
 * A `via_sync` row's stamped identity is the CHANNEL the content arrived on,
 * never a claim that the stamped user wrote it (038). When forensic resolution
 * cannot recover the real author from the payload's own client identities — no
 * prior evidence, evidence that maps one identity to two users, or a
 * deletion-only payload that asserts nothing — this entry says exactly that,
 * and the relayer is never credited instead.
 *
 * It states a DIFFERENT fact from UNKNOWN_AUTHOR (RBD-045-2), and the two may
 * appear side by side in one version:
 *   UNKNOWN_AUTHOR      — the row's identity was recorded; the account is gone.
 *   SYNCED_CONTRIBUTION — the row's identity is a relay channel; authorship is
 *                         not determinable.
 * When resolution SUCCEEDS but the resolved account has since been deleted, the
 * deleted-account rule wins (the identity WAS determined) and the version shows
 * UNKNOWN_AUTHOR.
 *
 * `isSynced` is additive and exists so the client can style this entry
 * distinctly without string-matching a display name.
 */
const SYNCED_CONTRIBUTION = Object.freeze({
  id: null,
  name: 'Synced content',
  email: null,
  picture: null,
  color: '#888888',
  isAgent: false,
  isSynced: true,
});

/** Fixed map key for SYNCED_CONTRIBUTION: any number of unresolvable origins,
 * across any number of rows, collapse into exactly ONE entry per version. */
const SYNCED_CONTRIBUTION_KEY = 'synced';

/**
 * Create an author object from update data or named version data
 * Shared helper to ensure consistent author representation
 * Accepts multiple input formats:
 *   - Update format: { userId, userName, userEmail, userPicture, agentName }
 *   - Named version format: { created_by, creator_name, creator_email, creator_picture }
 * @param {Object} data - Data object with user info
 * @returns {Object|null} Author object or null if no userId
 */
function createAuthor(data) {
  // Support both naming conventions
  const userId = data.userId || data.created_by;
  const userName = data.userName || data.creator_name;
  const userEmail = data.userEmail || data.creator_email;
  const userPicture = data.userPicture || data.creator_picture;
  const agentName = data.agentName;

  if (!userId) return null;

  const authorKey = getAuthorKey(userId, agentName);
  const displayName = agentName
    ? (userName ? `${agentName} (${userName})` : agentName)
    : (userName || 'Unknown');

  return {
    id: userId,
    name: displayName,
    email: userEmail,
    picture: userPicture,
    color: generateColorFromId(authorKey),
    isAgent: !!agentName,
  };
}

/**
 * Build the display author for a RESOLVED origin (feature 045).
 *
 * Identifiers come from the memoized resolution outcome; display fields come
 * from the per-request directory, never from the cache (R6), so a rename shows
 * up immediately. A resolved id absent from the directory is the
 * deleted-account signal (RBD-045-11) — the caller renders UNKNOWN_AUTHOR
 * rather than inventing a name.
 *
 * @param {{userId: string, agentName: string|null}} origin
 * @param {Map<string, {userName, userEmail, userPicture}>} directory
 * @returns {Object|null} the same shape `createAuthor` produces, or null
 */
function authorFromOrigin(origin, directory) {
  const fields = directory && typeof directory.get === 'function' ? directory.get(origin.userId) : null;
  if (!fields) return null;
  return createAuthor({
    userId: origin.userId,
    agentName: origin.agentName,
    userName: fields.userName,
    userEmail: fields.userEmail,
    userPicture: fields.userPicture,
  });
}

/**
 * The ONE place a row becomes contributor entries (feature 045, FR-007).
 *
 * `groupUpdatesIntoVersions` and `computeRangeMeta` used to carry
 * near-identical copies of this accumulation, with 041 requiring by comment
 * that they stay identical. They now call this instead, which is what makes
 * "one resolution, many renderers" structural rather than aspirational: no
 * surface can grow its own, divergeable notion of who authored a relayed row.
 *
 * With no resolution context — and for every row that is not `via_sync` — the
 * behavior is byte-for-byte the pre-045 logic, so the old baseline is always
 * one argument away and every direct-call test stays valid.
 *
 * @param {Object} update - an update row
 * @param {Map} authors - the version's author map (key -> author)
 * @param {{outcomes: Map, directory: Map}} [ctx] - resolution context
 */
function collectAuthorsForUpdate(update, authors, ctx = EMPTY_RESOLUTION) {
  const outcome = update.viaSync === true && ctx && ctx.outcomes
    ? ctx.outcomes.get(update.clock)
    : undefined;

  if (!outcome) {
    const authorKey = getAuthorKey(update.userId, update.agentName);
    if (update.userId && !authors.has(authorKey)) {
      authors.set(authorKey, createAuthor(update));
    } else if (!update.userId && !authors.has(UNKNOWN_AUTHOR_KEY)) {
      // Feature 040 (FR-008): a row with no user attribution still gets a
      // contributor entry, so a version whose rows all lost their user (a
      // deleted account — `yjs_updates.user_id` is ON DELETE SET NULL) shows
      // "Unknown author" instead of an empty list. The FIXED key collapses any
      // number of unattributed rows into exactly one entry, and lets it coexist
      // with the version's real authors.
      authors.set(UNKNOWN_AUTHOR_KEY, UNKNOWN_AUTHOR);
    }
    return;
  }

  // A resolved relayed row is displayed EXACTLY as a direct one: same
  // createAuthor shape, same keying, same dedupe. That is what preserves 038's
  // promise that a genuine offline edit stays credited to its author (FR-003).
  // The row's own stamped userId/agentName are never read here.
  for (const origin of outcome.origins) {
    const author = authorFromOrigin(origin, ctx.directory);
    if (!author) {
      if (!authors.has(UNKNOWN_AUTHOR_KEY)) authors.set(UNKNOWN_AUTHOR_KEY, UNKNOWN_AUTHOR);
      continue;
    }
    const key = getAuthorKey(origin.userId, origin.agentName);
    if (!authors.has(key)) authors.set(key, author);
  }
  if (outcome.unresolved && !authors.has(SYNCED_CONTRIBUTION_KEY)) {
    authors.set(SYNCED_CONTRIBUTION_KEY, SYNCED_CONTRIBUTION);
  }
}

/**
 * The collapse for surfaces that display exactly ONE author for a row — the
 * per-clock view and the MCP `lastModifiedBy` (feature 045, RBD-045-9).
 *
 * The RESOLUTION is identical to the timeline's; only the rendering arity
 * differs. A multi-origin or partially-resolved row shows the synced
 * contribution rather than "the first resolved origin", which would present a
 * true-but-partial author as the whole story and let this surface disagree with
 * the timeline about who is credited.
 *
 * @param {Object|null} update - the row, or null when there is no row at all
 * @param {{outcomes: Map, directory: Map}} [ctx]
 * @returns {Object|null} an author, or null when there is no row
 */
function authorForSingleSlot(update, ctx = EMPTY_RESOLUTION) {
  if (!update) return null;
  const outcome = update.viaSync === true && ctx && ctx.outcomes
    ? ctx.outcomes.get(update.clock)
    : undefined;
  if (!outcome) return createAuthor(update) || UNKNOWN_AUTHOR;
  if (!outcome.unresolved && outcome.origins.length === 1) {
    return authorFromOrigin(outcome.origins[0], ctx.directory) || UNKNOWN_AUTHOR;
  }
  return SYNCED_CONTRIBUTION;
}

/**
 * Dedupe a version's raw on-behalf-of push provenance by identity (name+email),
 * aggregating a push count and the most-recent commit/url per identity, then cap
 * the number of distinct identities with an overflow count.
 *
 * Input entries are the field-whitelisted, length-capped push objects
 * ({ name?, email?, commit?, url? }) collected in chronological
 * (ascending-clock) order, so "latest" == last seen. Output entries are
 * { name?, email?, commitCount, latestCommit?, latestUrl? } — still strictly
 * plain-text, untrusted values that the client renders inertly (the XSS posture
 * from the 004 review is load-bearing; nothing here makes them safe as markup).
 *
 * @param {Array} rawPushes - Per-version push provenance objects, chronological
 * @returns {{ identities: Array, moreIdentities: number }}
 */
function dedupeOnBehalfOf(rawPushes) {
  const byIdentity = new Map(); // identityKey -> aggregated entry (insertion order = first-seen)

  for (const p of rawPushes) {
    if (!p || typeof p !== 'object') continue;
    const name = typeof p.name === 'string' && p.name.length > 0 ? p.name : undefined;
    const email = typeof p.email === 'string' && p.email.length > 0 ? p.email : undefined;

    // Identity is the (name, email) pair; entries with neither collapse into a
    // single anonymous identity (still bounded).
    const key = `${name || ''}\u0000${email || ''}`;

    let entry = byIdentity.get(key);
    if (!entry) {
      entry = { name, email, commitCount: 0 };
      byIdentity.set(key, entry);
    }

    entry.commitCount += 1;
    // Chronological order => last write wins == most recent.
    if (typeof p.commit === 'string' && p.commit.length > 0) {
      entry.latestCommit = p.commit;
    }
    if (typeof p.url === 'string' && p.url.length > 0) {
      entry.latestUrl = p.url;
    }
  }

  const all = Array.from(byIdentity.values());
  return {
    identities: all.slice(0, MAX_ONBEHALFOF_IDENTITIES),
    moreIdentities: Math.max(0, all.length - MAX_ONBEHALFOF_IDENTITIES),
  };
}

/**
 * The one meaningful-classification predicate every version-history surface
 * reads (feature 023 US4, D-3): `null`/`undefined` (unknown — pre-023 rows, or
 * written by an old pod mid-deploy) counts as MEANINGFUL (fail-visible); only an
 * explicit `false` (classified noise) is dropped. Feature 041 gave the drill-down
 * this same rule, so the predicate lives in exactly one place.
 *
 * @param {Object} update - An update row
 * @returns {boolean} true when the row participates in version accounting
 */
function isMeaningful(update) {
  return !!update && update.meaningful !== false;
}

/**
 * Derive a version's displayed metadata from the update rows that actually fall
 * inside its own clock range (feature 041, FR-001..003).
 *
 * This exists because the presenter used to COPY the containing auto version's
 * `authors`/`onBehalfOf` onto ranges those lists do not describe: a named
 * version inherited them wholesale, and both split fragments got them via an
 * object spread. When a named version splits one editing burst between two
 * people, that credits each side with the other's work in BOTH directions
 * (ledger N-041-1) — the most direct violation of the attribution promise the
 * product makes.
 *
 * Rules (contracts/range-scoped-version-meta.md):
 *  - Author keying, the `createAuthor` shape, the UNKNOWN_AUTHOR collapse (040
 *    FR-008) and `dedupeOnBehalfOf` are IDENTICAL to `groupUpdatesIntoVersions`
 *    — this is the same computation over a different row selection, never a
 *    second, divergent notion of authorship.
 *  - Primary input is the in-range rows that pass `isMeaningful`.
 *  - R16 noise-only fallback: if the range HAS rows but all were filtered as
 *    noise, compute from the unfiltered in-range rows instead. Those are real
 *    editors of that range; an empty list is reserved for a range with no rows
 *    at all (FR-003), and the fallback set is still range-scoped, so no author
 *    from outside the range can ever appear.
 *  - `timestamp` is the LAST in-range row's `createdAt` (null when row-less);
 *    callers layer their own fallbacks on top.
 *
 * `updates` is expected in ascending clock order (every persistence reader
 * returns that), which is what makes "last in range" and dedupeOnBehalfOf's
 * latest-wins aggregation correct.
 *
 * @param {Array} updates - Update rows (ascending clock), any range
 * @param {number|null} clockStart - Inclusive lower bound (null ⇒ unbounded)
 * @param {number|null} clockEnd - Inclusive upper bound (null ⇒ unbounded)
 * @returns {{authors: Array, onBehalfOf: Array, onBehalfOfMore: number, timestamp: string|null}}
 */
/**
 * The (min, max) clock pair for a document, preferring the index-only query.
 *
 * Feature 042 (FR-009): the two range checks below used to materialize the
 * whole user-joined update log purely to take a min and a max. `getClockRange`
 * answers that from the index instead. A persistence without the method (the
 * hand-rolled mocks in the suites, and any older provider) still works: the
 * fallback derives the range from a log read exactly as before, so the checks
 * are capability-driven, never version-driven.
 *
 * @returns {Promise<{minClock: number|null, maxClock: number|null}>} nulls when
 *   the document has no updates at all.
 */
async function readClockRange(persistence, docGuid) {
  if (typeof persistence.getClockRange === 'function') {
    return persistence.getClockRange(docGuid);
  }
  return clockRangeOf(await persistence.getUpdatesWithUsers(docGuid));
}

/** The (min, max) clock pair of an ALREADY materialized log. */
function clockRangeOf(updates) {
  if (!updates || updates.length === 0) return { minClock: null, maxClock: null };
  const clocks = updates.map(u => u.clock);
  return { minClock: Math.min(...clocks), maxClock: Math.max(...clocks) };
}

/**
 * The ONE range check both content readers share (FR-009).
 *
 * `getYDocAtClock` is a `clock <= N` read, so an out-of-range clock silently
 * returns current content (clock > max) or an empty doc (clock < min) labelled
 * as the requested clock. Both callers must reject rather than serve that.
 *
 * The two callers' error TYPES and STRINGS genuinely differ (see
 * contracts/behavior-preservation.md C2 — `getVersionContent` throws a bare
 * Error for an empty log and prefixes its out-of-range message with the version
 * id; `getContentAtClock` throws VersionNotFoundError and does not), so the
 * errors are supplied by the caller. Only the DECISION is shared — including
 * that the empty-log branch wins over any range formatting.
 *
 * @param {number} clock - the clock being validated
 * @param {{minClock: number|null, maxClock: number|null}} range
 * @param {{onEmpty: function(): Error, onOutOfRange: function(number, number): Error}} errors
 */
function assertClockInRange(clock, range, { onEmpty, onOutOfRange }) {
  const { minClock, maxClock } = range;
  if (minClock == null || maxClock == null) throw onEmpty();
  if (clock < minClock || clock > maxClock) throw onOutOfRange(minClock, maxClock);
}

function computeRangeMeta(updates, clockStart, clockEnd, { resolution } = {}) {
  const lo = (clockStart === null || clockStart === undefined) ? -Infinity : clockStart;
  const hi = (clockEnd === null || clockEnd === undefined) ? Infinity : clockEnd;

  const inRange = (updates || []).filter(u => u && u.clock >= lo && u.clock <= hi);
  const meaningful = inRange.filter(isMeaningful);
  // R16: a noise-only range demonstrably has editors — credit them rather than
  // rendering an empty list (which reads as "nobody edited this").
  const rows = meaningful.length > 0 ? meaningful : inRange;

  if (rows.length === 0) {
    return { authors: [], onBehalfOf: [], onBehalfOfMore: 0, timestamp: null };
  }

  const authors = new Map();
  const rawPushes = [];

  for (const update of rows) {
    collectAuthorsForUpdate(update, authors, resolution);
    if (update.onBehalfOf && typeof update.onBehalfOf === 'object') {
      rawPushes.push(update.onBehalfOf);
    }
  }

  const { identities, moreIdentities } = dedupeOnBehalfOf(rawPushes);

  return {
    authors: Array.from(authors.values()),
    onBehalfOf: identities,
    onBehalfOfMore: moreIdentities,
    timestamp: rows[rows.length - 1].createdAt ?? null,
  };
}

/**
 * The subset of `computeRangeMeta` a split fragment overrides on top of its
 * parent auto version's spread (feature 041, FR-002): authors and sync-push
 * provenance only.
 *
 * The fragment KEEPS the parent's `timestamp` deliberately — a fragment is a
 * slice of one activity burst (all its rows are within the grouping threshold of
 * each other), the spec scopes only authors/provenance for fragments, and
 * rewriting fragment timestamps would change every existing document's rendered
 * history for no attribution gain. Named-version timestamps DO come from their
 * own range (FR-003), where the spec requires it.
 *
 * @param {Array} updates - Update rows, ascending clock
 * @param {number} clockStart - Fragment lower bound (inclusive)
 * @param {number} clockEnd - Fragment upper bound (inclusive)
 * @returns {{authors: Array, onBehalfOf: Array, onBehalfOfMore: number}}
 */
function computeFragmentMeta(updates, clockStart, clockEnd, { resolution } = {}) {
  const { authors, onBehalfOf, onBehalfOfMore } = computeRangeMeta(updates, clockStart, clockEnd, { resolution });
  return { authors, onBehalfOf, onBehalfOfMore };
}

/**
 * Group updates into logical versions based on time gaps
 * @param {Array} updates - Array of updates with clock, createdAt, and user info
 * @param {number} inactivityThreshold - Time gap to create new version (ms)
 * @returns {Array} Array of version objects
 */
function groupUpdatesIntoVersions(updates, inactivityThreshold = DEFAULT_INACTIVITY_THRESHOLD, { resolution } = {}) {
  if (!updates || updates.length === 0) {
    return [];
  }

  const versions = [];
  let currentVersion = null;

  for (const update of updates) {
    const updateTime = new Date(update.createdAt).getTime();

    if (!currentVersion ||
        (updateTime - currentVersion.lastUpdateTime > inactivityThreshold)) {
      // Start a new version
      currentVersion = {
        clockStart: update.clock,
        clockEnd: update.clock,
        timestamp: update.createdAt,
        lastUpdateTime: updateTime,
        authors: new Map(), // userId -> user info
        onBehalfOf: [], // sync-push provenance (feature 004, D8); plain text
      };
      versions.push(currentVersion);
    } else {
      // Extend current version
      currentVersion.clockEnd = update.clock;
      currentVersion.timestamp = update.createdAt; // Update to latest timestamp
      currentVersion.lastUpdateTime = updateTime;
    }

    // Track unique authors (feature 045: through the ONE shared accumulator, so
    // this surface and `computeRangeMeta` cannot diverge — including on who
    // authored a sync-relayed row).
    //
    // NOTE: `getUpdatesForVersion` (the sub-version drill-down) calls THIS SAME
    // function, so the unattributed-row rule (040 FR-008) and the relayed-row
    // rule (045) both land on both paths. Do not duplicate either there.
    collectAuthorsForUpdate(update, currentVersion.authors, resolution);

    // Collect on-behalf-of provenance from sync-push updates in this version.
    if (update.onBehalfOf && typeof update.onBehalfOf === 'object') {
      currentVersion.onBehalfOf.push(update.onBehalfOf);
    }
  }

  // Convert author maps to arrays and dedupe+cap on-behalf-of provenance.
  return versions.map(v => {
    const { identities, moreIdentities } = dedupeOnBehalfOf(v.onBehalfOf);
    return {
      ...v,
      authors: Array.from(v.authors.values()),
      onBehalfOf: identities,
      onBehalfOfMore: moreIdentities,
    };
  });
}

/**
 * Merge named versions with auto-generated versions
 * Named versions take precedence and can split auto versions
 *
 * Feature 041 (FR-001..003): every version this returns — the named versions and
 * BOTH kinds of split fragment — derives its `authors`/`onBehalfOf` from the rows
 * inside its own clock range via `computeRangeMeta`, never from the containing
 * auto version. Passing `updates` is therefore how a caller gets truthful
 * attribution; a caller that omits it (legacy 2-arg call) gets empty author lists
 * on split output rather than a plausible-looking lie.
 *
 * @param {Array} autoVersions - Auto-generated versions from time grouping
 * @param {Array} namedVersions - User-created named versions
 * @param {Array} [updates] - The document's update rows, ascending by clock,
 *   UNFILTERED. `computeRangeMeta` applies the meaningful rule per range, which
 *   is what lets it distinguish a row-less range (empty authors, FR-003) from a
 *   noise-only one (credit its real in-range editors, R16).
 * @returns {Array} Merged version list
 */
function mergeNamedVersions(autoVersions, namedVersions, updates = [], { resolution } = {}) {
  if (!namedVersions || namedVersions.length === 0) {
    return autoVersions.map((v, i) => ({
      ...v,
      id: String(v.clockEnd),
      isNamed: false,
      isCurrent: i === autoVersions.length - 1,
    }));
  }

  // Create named version objects with metadata
  const namedVersionObjects = namedVersions.map(nv => {
    // Range-scoped truth first (FR-001/FR-003): authors and provenance come from
    // the named range's OWN rows, so they no longer depend on a matching auto
    // version existing at all — which is what left a named version whose
    // boundary row was noise-classified authorless (report A7).
    const rangeMeta = computeRangeMeta(updates, nv.clock_start, nv.clock_end, { resolution });

    // The matching auto version survives ONLY as a timestamp fallback layer.
    const matchingAutoVersion = autoVersions.find(av =>
      av.clockStart <= nv.clock_end && av.clockEnd >= nv.clock_end
    );

    // Prefer original_timestamp (from yjs_updates), then the range's own last
    // row, then the matching auto version, then created_at.
    const timestamp = nv.original_timestamp
      || rangeMeta.timestamp
      || matchingAutoVersion?.timestamp
      || nv.created_at;

    return {
      id: nv.id,
      name: nv.name,
      clockStart: nv.clock_start,
      clockEnd: nv.clock_end,
      timestamp,
      isNamed: true,
      createdBy: createAuthor(nv),
      authors: rangeMeta.authors,
      onBehalfOf: rangeMeta.onBehalfOf,
      onBehalfOfMore: rangeMeta.onBehalfOfMore,
    };
  });

  // Process auto versions, splitting them around named versions
  const result = [];
  let maxClock = 0;

  for (const autoVersion of autoVersions) {
    // Find all named versions that overlap with this auto version
    const overlappingNamed = namedVersionObjects.filter(
      nv => nv.clockStart <= autoVersion.clockEnd && nv.clockEnd >= autoVersion.clockStart
    );

    if (overlappingNamed.length === 0) {
      // No overlap - keep the auto version as-is
      result.push({
        ...autoVersion,
        id: String(autoVersion.clockEnd),
        isNamed: false,
      });
    } else {
      // Split the auto version around named versions
      // Named versions end at their clockEnd, so we need to create fragments
      // for clocks that come AFTER named versions
      // Sort overlapping named versions by clockEnd descending to process from end
      overlappingNamed.sort((a, b) => b.clockEnd - a.clockEnd);

      let currentEnd = autoVersion.clockEnd;

      for (const nv of overlappingNamed) {
        // Add auto version fragment after this named version (if any).
        // FR-002: the spread would carry the PARENT's authors/onBehalfOf onto a
        // range they do not describe — recompute from the fragment's own rows.
        if (nv.clockEnd < currentEnd) {
          result.push({
            ...autoVersion,
            clockStart: nv.clockEnd + 1,
            clockEnd: currentEnd,
            id: String(currentEnd),
            isNamed: false,
            ...computeFragmentMeta(updates, nv.clockEnd + 1, currentEnd, { resolution }),
          });
        }

        // Move back past the named version's range
        currentEnd = nv.clockStart - 1;
      }

      // Add any remaining fragment before the first named version (same FR-002
      // rule — this is the other half of the bidirectional lie, N-041-1).
      if (autoVersion.clockStart <= currentEnd) {
        result.push({
          ...autoVersion,
          clockStart: autoVersion.clockStart,
          clockEnd: currentEnd,
          id: String(currentEnd),
          isNamed: false,
          ...computeFragmentMeta(updates, autoVersion.clockStart, currentEnd, { resolution }),
        });
      }
    }

    maxClock = Math.max(maxClock, autoVersion.clockEnd);
  }

  // Add named versions
  for (const nv of namedVersionObjects) {
    result.push(nv);
  }

  // Sort by clockEnd descending (most recent first)
  result.sort((a, b) => b.clockEnd - a.clockEnd);

  // Mark current version
  if (result.length > 0) {
    result[0].isCurrent = true;
  }

  return result;
}

/**
 * Format timestamp for display
 * @param {Date|string} timestamp - Timestamp to format
 * @returns {string} Formatted timestamp (e.g., "December 10, 4:44 PM")
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const options = {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  return date.toLocaleString('en-US', options);
}


/**
 * Get version history timeline for a document
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @returns {Promise<Object>} Version timeline data
 */
async function getVersionTimeline(persistence, docGuid) {
  // Get all updates with user info
  const allUpdates = await persistence.getUpdatesWithUsers(docGuid);

  if (allUpdates.length === 0) {
    return {
      versions: [],
      totalEdits: 0,
    };
  }

  // Feature 023 US4: filter on the persisted meaningful flag instead of
  // replaying the whole log. O(rows), independent of document content size
  // (FR-016). NULL (unknown — pre-023 rows, or written by an old pod during a
  // deploy) is KEPT as meaningful (fail-visible, D-3); only an explicit `false`
  // (classified noise) is dropped.
  const updates = allUpdates.filter(isMeaningful);

  if (updates.length === 0) {
    return {
      versions: [],
      totalEdits: 0,
    };
  }

  // Get named versions
  const namedVersions = await persistence.getNamedVersions(docGuid);

  // Feature 045: resolve every sync-relayed row ONCE for the whole request, so
  // the timeline, its named versions and its split fragments cannot disagree
  // about who authored relayed content. A document with no `via_sync` rows
  // costs nothing here — the resolver returns without a query or a decode — and
  // the resolver issues its own targeted payload reads, so this call site stays
  // O(rows) with no payloads on the timeline query (023 FR-016).
  const resolution = await resolveForRows(persistence, docGuid, allUpdates);

  // Group updates into auto versions
  const autoVersions = groupUpdatesIntoVersions(updates, DEFAULT_INACTIVITY_THRESHOLD, { resolution });

  // Merge with named versions. The rows go along so named versions and split
  // fragments compute their authors/provenance from their OWN clock ranges
  // (feature 041, FR-001..003) — no extra query, no replay, so the timeline
  // stays O(rows) (023 FR-016).
  //
  // The UNFILTERED set is passed deliberately: `computeRangeMeta` applies the
  // meaningful rule itself, per range, which is the only way it can tell "this
  // range has no rows at all" (FR-003 ⇒ empty authors) apart from "this range
  // is all noise" (R16 ⇒ credit its real, in-range editors). Handing it the
  // pre-filtered array would collapse those two into one indistinguishable
  // empty case.
  const versions = mergeNamedVersions(autoVersions, namedVersions, allUpdates, { resolution });

  // Format versions for API response
  const formattedVersions = versions.map(v => ({
    id: v.id,
    name: v.name || null,
    clockStart: v.clockStart,
    clockEnd: v.clockEnd,
    timestamp: v.timestamp,
    formattedTimestamp: formatTimestamp(v.timestamp),
    authors: v.authors || [],
    isNamed: v.isNamed || false,
    isCurrent: v.isCurrent || false,
    // Sync-push provenance (feature 004, D8), deduped by identity and capped
    // (review note #5); rendered strictly as plain text by the client.
    onBehalfOf: v.onBehalfOf || [],
    onBehalfOfMore: v.onBehalfOfMore || 0,
  }));

  // Client handles grouping by month for proper local timezone handling
  return {
    versions: formattedVersions,
    totalEdits: updates.length,
  };
}

/**
 * Get document content at a specific version
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {string} versionId - Version ID (UUID for named versions, or clock number as string)
 * @param {object} [opts]
 * @param {boolean} [opts.withGap=false] - when true, additively return `gapped`
 *   (from the gap-tolerant content read) so a stored-artifact caller (restore,
 *   023 FR-009/D-2) can fail closed on a torn log. Serving-only callers (version
 *   preview, compare) omit it and keep serving as-is.
 * @returns {Promise<Object>} Version content and metadata
 */
async function getVersionContent(persistence, docGuid, versionId, { withGap = false } = {}) {
  let clockEnd;
  let versionMeta = null;

  // Check if it's a named version (UUID format)
  if (versionId.match(/^[0-9a-f-]{36}$/i)) {
    // getVersionById is doc-scoped at the SQL layer (F7), so a foreign version
    // id resolves to null here — the cross-doc leak is impossible below the
    // call. The JS-level doc_id equality check is kept as belt-and-suspenders
    // (and still guards mock persistences in tests). Indistinguishable
    // "not found" wording so a foreign id leaks nothing.
    const namedVersion = await persistence.getVersionById(versionId, docGuid);
    if (!namedVersion || namedVersion.doc_id !== docGuid) {
      throw new VersionNotFoundError('Version not found');
    }
    clockEnd = namedVersion.clock_end;
    versionMeta = {
      id: namedVersion.id,
      name: namedVersion.name,
      clockStart: namedVersion.clock_start,
      clockEnd: namedVersion.clock_end,
      timestamp: namedVersion.created_at,
    };

    // Feature 023 US3 (FR-012): named-version content is ALWAYS produced by
    // replaying the log to clock_end under the gap-tolerant read path — never
    // from a stored blob. The old cached-snapshot fast-path is removed; a pre-023
    // diverged blob heals silently to the replayed truth (D-6).
  } else {
    // Parse as clock number
    clockEnd = parseInt(versionId, 10);
    if (isNaN(clockEnd)) {
      throw new VersionNotFoundError('Invalid version ID format');
    }
  }

  // Validate that the requested clock exists.
  //
  // Feature 042 (FR-009): a NAMED version already resolved its metadata from
  // `getVersionById` above, so the log read here was purely a min/max check and
  // is replaced by the index-only range query. A CLOCK-NUMBER version id still
  // reads the log, because the grouping below genuinely needs those rows — only
  // the redundant scan is eliminated, not the data the path uses.
  const errors = {
    onEmpty: () => new Error('Document has no version history'),
    onOutOfRange: (min, max) =>
      new VersionNotFoundError(`Version not found: ${versionId} (clock ${clockEnd} out of range ${min}-${max})`),
  };

  let updates = null;
  if (versionMeta) {
    assertClockInRange(clockEnd, await readClockRange(persistence, docGuid), errors);
  } else {
    updates = await persistence.getUpdatesWithUsers(docGuid);
    assertClockInRange(clockEnd, clockRangeOf(updates), errors);
  }

  // Reconstruct document at the specified clock. Read WITH the gap indicator so
  // a stored-artifact caller (restore) can refuse a torn read (023 FR-009/D-2);
  // a plain Y.Doc from a mock/serving path unwraps to gapped=false.
  //
  // Feature 041 (FR-012): the STORED-ARTIFACT caller also demands tail
  // completeness. Interior-gap detection alone let a read that stopped short of
  // `clockEnd` look complete, so restore could build its artifact from an
  // earlier state while labelling it with the requested version — a hole in the
  // fail-closed guarantee. Passing `expectedTailClock` is safe against the
  // CD-5/G5 sentinel hazard precisely here: `clockEnd` was validated against the
  // document's real min/max above, so it is always a committed clock, never a
  // "whole log" sentinel. Serving-only callers (preview, compare) never opt in.
  const atClockRead = await persistence.getYDocAtClock(docGuid, clockEnd, {
    withGap: true,
    ...(withGap ? { expectedTailClock: clockEnd } : {}),
  });
  const ydoc = atClockRead instanceof Y.Doc ? atClockRead : atClockRead.ydoc;
  const contentGapped = atClockRead instanceof Y.Doc ? false : !!atClockRead.gapped;
  const content = Y.encodeStateAsUpdate(ydoc);

  // Get version metadata if not already set
  if (!versionMeta) {
    // Group the meaningful-filtered set for parity with getVersionTimeline
    // (feature 023 US4): NULL kept, explicit noise dropped — so a clock that is
    // a version boundary in the timeline resolves to the same auto-version here.
    const meaningfulUpdates = updates.filter(isMeaningful);
    // Feature 047 (NF-2): resolve relayed rows BEFORE grouping. This grouping is
    // the only author-producing path in the module that used to run without a
    // resolution context, so a `via_sync` row's stamped RELAYER was emitted as an
    // author — the exact lie 045 closed everywhere else. It is not a web-only
    // corner: `versionMeta.authors` is returned verbatim to MCP
    // `read_document({versionId})` and `compare_document_versions`, and to REST
    // `GET /api/docs/:docId/versions/:versionId`. Resolved over the FULL row set
    // (as `getContentAtClock` does) rather than the meaningful-filtered one, so
    // the display directory is built from every row the read already fetched.
    const resolution = await resolveForRows(persistence, docGuid, updates);
    const autoVersions = groupUpdatesIntoVersions(
      meaningfulUpdates, DEFAULT_INACTIVITY_THRESHOLD, { resolution }
    );
    const version = autoVersions.find(v => v.clockEnd === clockEnd);

    if (version) {
      versionMeta = {
        id: versionId,
        name: null,
        clockStart: version.clockStart,
        clockEnd: version.clockEnd,
        timestamp: version.timestamp,
        authors: version.authors,
      };
    }
  }

  const result = {
    content: Array.from(content),
    version: versionMeta,
  };
  if (withGap) result.gapped = contentGapped;
  return result;
}

/**
 * Restore document to a previous version (non-destructive) — the ONE shared core
 * behind both restore surfaces (REST route and MCP tool), feature 023 US5.
 * Creates the restore as a single new update, records an undo-invertible edit
 * record for it, and broadcasts it live on every instance (no silent skip).
 *
 * ── WHERE THE STORED DELTA COMES FROM (features 041 + 048, FR-011) ───────────
 * The restore always runs on a fresh EPHEMERAL Y.Doc, never on the live one.
 * Only the seed differs: a trusted live copy on this instance (bind complete and
 * at least one live connection) is the most current state available, and the
 * persisted state is the honest fallback for everything else. The stored row is
 * that ephemeral transaction's own bytes.
 *
 * The 041 invariant still holds, and now trivially: the stored bytes ARE the
 * bytes handed to applyLiveUpdate — literally the same reference. What 041 fixed
 * was a delta computed from a separate Postgres read, where an edit landing
 * between the read and the store interleaved invisibly and the row labelled
 * "restore to version X" encoded a different transition than the one users saw.
 *
 * Feature 048 moved WHERE the transaction runs, for attribution: the shared
 * server doc has one Yjs clientID for the whole process, so a restore authored
 * on it could not be told apart from anyone else's server-side write. On an
 * ephemeral doc the restore carries its own one-shot identity.
 *
 * ── DOCUMENTED RESIDUALS ─────────────────────────────────────────────────────
 * 1. CROSS-POD (RBD-041-2): a document loaded only on ANOTHER instance takes the
 *    not-loaded path, so restore is not serialized against writes happening
 *    there. Full cross-pod serialization needs a distributed doc-level lock and
 *    is deliberately out of scope.
 * 2. ORDERING (RBD-048-2): store-then-apply, for both cases. The durable row is
 *    committed first and the broadcast follows, which flips the crash window to
 *    its safer half: a crash between the two leaves a durable row that replays
 *    on the next load, rather than a fan-out with nothing behind it. The other
 *    accepted consequence is that an edit landing during the store await MERGES
 *    with the restore instead of being replaced — which is what the durable path
 *    and every cross-pod restore already did. Both are uniform now rather than
 *    depending on whether the document happened to be loaded here.
 *
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {string} versionId - Version ID to restore
 * @param {string} userId - User performing the restore
 * @param {object} [deps]
 * @param {Function|null} [deps.getSharedDoc] - docGuid -> Y.Doc|null (in-memory doc)
 * @param {object|null} [deps.redisPubSub] - cross-instance fan-out when not loaded
 * @param {string|null} [deps.agentName] - Acting agent name, or `null` for a
 *   human web-UI restore. An MCP restore passes the agent token's own name and
 *   is recorded as that agent's undoable edit; a human restore is attributed to
 *   the human in the update log and is NOT an undo target (see below).
 * @returns {Promise<Object>} Result with new version info
 */
async function restoreVersion(persistence, docGuid, versionId, userId, {
  getSharedDoc = null,
  redisPubSub = null,
  agentName = null,
} = {}) {
  // Get the target version content, WITH the gap indicator (023 FR-009/D-2).
  const { content, gapped: targetGapped } = await getVersionContent(persistence, docGuid, versionId, { withGap: true });

  // Get current document state, WITH the gap indicator (a plain Y.Doc from a
  // mock/serving path unwraps to gapped=false).
  const currentRead = await persistence.getYDoc(docGuid, { withGap: true });
  const currentYdoc = currentRead instanceof Y.Doc ? currentRead : currentRead.ydoc;
  const currentGapped = currentRead instanceof Y.Doc ? false : !!currentRead.gapped;

  // F3 (FR-009, D-2): restore is the one stored-artifact path (the restore update
  // row + its agent_edits record). If EITHER read is still gapped after the shared
  // retry budget, refuse — the same fail-closed posture undo uses — rather than
  // persist content derived from a torn log. No row is stored, no record written.
  if (targetGapped || currentGapped) {
    console.warn(`[Restore] aborting restore of ${docGuid}: update log still gapped after retry budget`);
    throw new DocumentSyncingError('Restore aborted: the document is still syncing — retry in a moment.');
  }

  // Create target document from version to get the content we want
  const targetYdoc = new Y.Doc();
  Y.applyUpdate(targetYdoc, new Uint8Array(content));

  /** The restore transition itself: drop the fragment's contents and re-insert a
   *  clone of the target version's. This is the shipped, designed restore
   *  semantic (design/collaboration-core.md, "Restore is non-destructive") and is
   *  unchanged here — feature 041 only moved WHERE it runs, and feature 042
   *  (FR-010) only moved the generic Yjs surgery into `yjs-utils`, verbatim and
   *  with its Principle IV tension recorded there (DEC-9). */
  const applyRestoreTo = (doc) => {
    replaceFragmentContents(doc.getXmlFragment('default'), targetYdoc.getXmlFragment('default'));
  };

  // Is the document live on THIS instance? Asked through the non-creating peek
  // (FR-013) — the old creating lookup made this always "yes" and leaked a doc
  // per restore of an unopened document.
  let liveDoc = null;
  try {
    liveDoc = getSharedDoc ? getSharedDoc(docGuid) : null;
  } catch (peekErr) {
    console.error(`[Restore] live-doc lookup failed for ${docGuid} (falling back to the durable path):`, peekErr.message);
    liveDoc = null;
  }

  // Feature 046 (NEW-2a/NEW-2b): finding a doc in the registry is NOT the same
  // as finding a doc whose state may be transacted on and STORED. A half-loaded
  // doc (bindState is not awaited) makes `replaceFragmentContents` delete
  // nothing, so the stored row is the target clone alone and the in-flight load
  // then merges the old content back in — durably, everywhere. A leaked
  // connection-less doc is frozen at whenever a server-side write created it, so
  // the stored row describes a transition from state the document left long ago.
  // Both refuse to the durable path, which is what already runs for a document
  // nobody has open. See server/live-doc-trust.js for the full reasoning.
  if (liveDoc && !isTrustedLiveDoc(liveDoc)) {
    console.warn(
      `[Restore] ignoring the live copy of ${docGuid} (${untrustedReason(liveDoc)})`
      + ' — computing the restore from the durable log instead'
    );
    liveDoc = null;
  }

  // ── ONE COMPUTE PATH (feature 048, FR-004) ─────────────────────────────────
  // The restore runs on a fresh ephemeral doc, never on the live one. Only the
  // SEED differs between the two cases: a trusted live copy is the most current
  // state available on this instance, and the persisted state is the honest
  // fallback for everything else. This is the durable path generalized, so both
  // cases share one shape — and the restore, like every other server-side
  // write, is authored under a one-shot clientID rather than the shared doc's.
  const seed = liveDoc
    ? Y.encodeStateAsUpdate(liveDoc)
    : Y.encodeStateAsUpdate(currentYdoc);

  let restoreUpdate;
  const eph = new Y.Doc();
  try {
    Y.applyUpdate(eph, seed);
    const stateVectorBeforeRestore = Y.encodeStateVector(eph);
    eph.transact(() => applyRestoreTo(eph));
    // A no-change restore produces the (empty) transition, keeping the stored
    // row and `newClock` semantics identical in both cases.
    restoreUpdate = Y.encodeStateAsUpdate(eph, stateVectorBeforeRestore);
  } finally {
    eph.destroy();
  }

  // Store as a single new update (the restore operation). Classified meaningful
  // by construction (feature 023 US4) — a restore always changes visible content.
  const newClock = await persistence.storeUpdate(docGuid, restoreUpdate, userId, agentName, null, null, { meaningful: true });

  // Record the restore as an edit record so log-derived undo can invert it
  // (feature 023 FR-020, D-4) — but ONLY for an agent restore.
  //
  // A human web-UI restore (`agentName === null`) is deliberately NOT recorded.
  // The restore itself still lands in `yjs_updates` attributed to the human, so
  // history shows who did it and the restore is reverted the ordinary way, by
  // restoring again. It is simply not an undo target.
  //
  // Why not: the only edits recorded under the chat-assistant identity are chat
  // `modify` calls, which is exactly what the chat "Undo edit" button sits on.
  // Because the LIFO undo target and the card the button lives on are always
  // the same record, mislabelling is structurally impossible. Putting restores
  // into that same queue (feature 040, since cut) broke that invariant and
  // needed a guard apparatus to contain the divergence — for a capability with
  // no UI to invoke it, at the cost of attributing a human's restore to the
  // assistant. See specs/040-restore-undo-attribution/ (US1/US6 CUT).
  //
  // An MCP restore passes its own `agentName` and is recorded as that agent's
  // edit, undoable by that agent, exactly as it has been since 023.
  //
  // Non-fatal (modify parity, D6): a recording failure logs and the restore
  // still succeeds — undo simply finds nothing to invert. The user's content
  // change is never lost to a bookkeeping failure.
  if (agentName) {
    try {
      await editRecords.recordEdit(persistence, {
        docGuid,
        userId,
        agentName,
        clockStart: newClock,
        clockEnd: newClock,
        clocks: [newClock],
      });
    } catch (recordErr) {
      console.error(`[Restore] Failed to record edit for ${docGuid} (restore still succeeds):`, recordErr.message);
    }
  }

  // ── ONE BROADCAST CALL (feature 048, FR-004) ───────────────────────────────
  // The transaction ran on the ephemeral doc, so the live copy — if there is one
  // here — does NOT have this update yet and must be applied to like any other
  // instance. That makes applyLiveUpdate correct for both cases: loaded here →
  // apply + fan out (its H1 guard publishes only when no attached handler
  // already did); not loaded → publish to Redis; neither → the never-silent
  // warn (feature 023 FR-023, D-5).
  //
  // ORIGIN_RESTORE makes the bindState persistence listener skip re-storing
  // (storeUpdate allocates a fresh clock per call and never dedupes by content,
  // so a parseable origin here would double-persist). Non-fatal throughout: the
  // row is already durable.
  applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, restoreUpdate, ORIGIN_RESTORE, 'Restore');

  return {
    success: true,
    newClock,
    message: 'Document restored successfully',
  };
}

/**
 * Get updates within a clock range, grouped into sub-versions (for drill-down)
 * Groups updates with less than 10 seconds between them into sub-versions
 * Filters out redundant/duplicate updates that don't change the document state
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {number} clockStart - Starting clock value (inclusive)
 * @param {number} clockEnd - Ending clock value (inclusive)
 * @param {number} limit - Maximum number of subversions to return (default: 10)
 * @returns {Promise<Object>} Object with subversions array and metadata
 */
async function getUpdatesForVersion(persistence, docGuid, clockStart, clockEnd, limit = 10) {
  const startTime = Date.now();
  // Metadata only: everything below reads clocks, timestamps and attribution —
  // never the update payload — so feature 042 (FR-015) stopped transferring the
  // blobs this call used to fetch and immediately map away.
  const updates = await persistence.getUpdatesInRange(docGuid, clockStart, clockEnd, { includeData: false });
  const fetchTime = Date.now() - startTime;

  // Feature 041 (FR-004): apply the TIMELINE's meaningful rule before grouping.
  // The drill-down was the one surface that skipped it, so it emitted sub-groups
  // built entirely from classified noise — updates the timeline does not count
  // and the user cannot see — and the two surfaces disagreed on totals (SC-002).
  const meaningfulUpdates = updates.filter(isMeaningful);

  // Feature 045: the drill-down resolves the SAME way the timeline does, over
  // its own range rows, so the two surfaces always report one answer for a
  // relayed row.
  const resolution = await resolveForRows(persistence, docGuid, meaningfulUpdates);

  // Group updates into sub-versions using 10-second threshold
  // No document reconstruction needed - just return metadata about update groupings
  const groupStart = Date.now();
  const subVersions = groupUpdatesIntoVersions(
    meaningfulUpdates.map(u => ({
      clock: u.clock,
      createdAt: u.createdAt,
      userId: u.userId,
      userName: u.userName,
      userEmail: u.userEmail,
      userPicture: u.userPicture,
      agentName: u.agentName,
      // Feature 045: this projection used to DROP viaSync, which would have
      // silently disabled resolution on the drill-down — the surface would then
      // credit the relayer while the timeline credited the true author.
      viaSync: u.viaSync,
    })),
    UPDATE_GROUPING_THRESHOLD,
    { resolution }
  );
  const groupTime = Date.now() - groupStart;

  // Map to response format and reverse to show most recent first (newest first).
  // subVersions is ASCENDING (oldest first); the .reverse() happens after this
  // map. A sub-version's diff baseline is the END of the PREVIOUS (older)
  // sub-version — subVersions[i - 1].clockEnd — and the oldest sub-version
  // (i === 0) diffs against the clock just before the range (clockStart - 1).
  const allSubversions = subVersions.map((sv, i) => ({
    id: String(sv.clockEnd),
    clockStart: sv.clockStart,
    clockEnd: sv.clockEnd,
    previousClock: i === 0
      ? (clockStart > 0 ? clockStart - 1 : -1)
      : subVersions[i - 1].clockEnd,
    timestamp: sv.timestamp,
    formattedTimestamp: formatTimestamp(sv.timestamp),
    authors: sv.authors || [],
    // FR-004: count the rows that actually survived the meaningful filter, not
    // the clock span. Clock arithmetic counted noise rows (and any clock the
    // range never contained), inflating the drill-down past what the timeline
    // accounts for.
    updateCount: meaningfulUpdates.filter(u => u.clock >= sv.clockStart && u.clock <= sv.clockEnd).length,
  })).reverse();

  // Apply limit (most recent first)
  const total = allSubversions.length;
  const limitedSubversions = allSubversions.slice(0, limit);
  const hasMore = total > limit;

  const totalTime = Date.now() - startTime;
  console.log(`[getUpdatesForVersion] clocks ${clockStart}-${clockEnd}: fetch=${fetchTime}ms, group=${groupTime}ms, total=${totalTime}ms, updates=${updates.length}, meaningful=${meaningfulUpdates.length}, subversions=${total}, returned=${limitedSubversions.length}`);

  return {
    subversions: limitedSubversions,
    total,
    hasMore,
  };
}

/**
 * Get authors from the current editing session
 * Uses same grouping logic as version history (5-minute inactivity threshold)
 * @param {Array} updates - Array of updates with user info (in ascending clock order)
 * @param {object} [options]
 * @param {{outcomes: Map, directory: Map}} [options.resolution] - feature 045:
 *   the caller resolves (it is the one holding the persistence provider) and
 *   passes the context in, which keeps this function SYNCHRONOUS. Omitting it
 *   yields exactly the pre-045 behavior.
 * @returns {Array} Authors from the most recent session (last version)
 */
function getCurrentSessionAuthors(updates, { resolution } = {}) {
  if (!updates || updates.length === 0) return [];
  const versions = groupUpdatesIntoVersions(updates, DEFAULT_INACTIVITY_THRESHOLD, { resolution });
  if (versions.length === 0) return [];
  return versions[versions.length - 1].authors;
}

/**
 * Get document content at a specific clock value
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {number} clock - Clock value
 * @returns {Promise<Object>} Document content and metadata
 */
async function getContentAtClock(persistence, docGuid, clock) {
  // Range-check FIRST (same contract as getVersionContent): getYDocAtClock is a
  // clock <= N read, so an out-of-range clock silently returns current content
  // (clock > max) or an empty doc (clock < min) mislabeled as that clock. Reject
  // so the route can 404 instead of serving a mislabeled snapshot.
  //
  // Feature 042 (FR-009): nothing else here consumed the log, so this read is
  // now the index-only range query.
  assertClockInRange(clock, await readClockRange(persistence, docGuid), {
    onEmpty: () => new VersionNotFoundError('Document has no version history'),
    onOutOfRange: (min, max) =>
      new VersionNotFoundError(`Version not found: clock ${clock} out of range ${min}-${max}`),
  });

  const ydoc = await persistence.getYDocAtClock(docGuid, clock);
  const content = Y.encodeStateAsUpdate(ydoc);

  // Get metadata for this clock
  // Metadata only (042, FR-015): just createdAt and the author come from this row.
  const updates = await persistence.getUpdatesInRange(docGuid, clock, clock, { includeData: false });
  const update = updates[0];

  // Feature 045: a relayed row's stamped identity is the channel, not the
  // author, on THIS surface too. One row, the same resolution the timeline
  // uses, collapsed to the single slot this view renders (RBD-045-9).
  const resolution = await resolveForRows(persistence, docGuid, updates);

  return {
    content: Array.from(content),
    clock,
    timestamp: update?.createdAt || null,
    formattedTimestamp: update ? formatTimestamp(update.createdAt) : null,
    // Feature 040 (FR-008): a row that genuinely EXISTS but yields no author
    // (its user was deleted) resolves to the synthetic unknown contributor
    // rather than a bare null. `null` here is reserved for "there is no row
    // at this clock at all", which is a different statement.
    author: authorForSingleSlot(update, resolution),
  };
}

module.exports = {
  generateColorFromId,
  createAuthor,
  // Feature 040 (FR-008): the synthetic contributor for unattributed rows.
  UNKNOWN_AUTHOR,
  // Feature 045 (FR-004): the synthetic contributor for sync-relayed content
  // whose author cannot be derived. States a different fact from
  // UNKNOWN_AUTHOR (RBD-045-2); both may appear in one version.
  SYNCED_CONTRIBUTION,
  SYNCED_CONTRIBUTION_KEY,
  // Feature 045 (RBD-045-9/RBD-045-12): the one-author collapse the per-clock
  // view and MCP's lastModifiedBy share.
  authorForSingleSlot,
  // Feature 041 (FR-001..004): the shared meaningful predicate and the
  // range-scoped metadata computation behind truthful version attribution.
  isMeaningful,
  computeRangeMeta,
  groupUpdatesIntoVersions,
  mergeNamedVersions,
  formatTimestamp,
  getVersionTimeline,
  getVersionContent,
  getUpdatesForVersion,
  getContentAtClock,
  getCurrentSessionAuthors,
  restoreVersion,
  VersionNotFoundError,
  DocumentSyncingError,
  DEFAULT_INACTIVITY_THRESHOLD,
  UPDATE_GROUPING_THRESHOLD,
};
