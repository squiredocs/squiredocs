# Phase 0 Research — 041-version-history-truth

All mechanisms below were resolved against main @ 603a494b by direct code reading
(no NEEDS CLARIFICATION markers remained in the Technical Context; the entries
here are the mechanism-level decisions the spec deliberately left to the plan).
File:line references verified 2026-08-02.

---

## R1 — Range-scoped version metadata (FR-001, FR-002, FR-003 / A1+A7)

- **Decision**: Add a pure helper `computeRangeMeta(updates, clockStart, clockEnd)`
  in `server/version-history.js` returning `{ authors, onBehalfOf, onBehalfOfMore,
  timestamp }` derived ONLY from rows with `clockStart <= clock <= clockEnd`,
  reusing the exact author-key/`createAuthor`/`UNKNOWN_AUTHOR`/`dedupeOnBehalfOf`
  logic `groupUpdatesIntoVersions` uses (timestamp = last row in range).
  `mergeNamedVersions(autoVersions, namedVersions)` gains a third parameter — the
  same meaningful-filtered `updates` array `getVersionTimeline` already holds —
  and uses the helper at **all three inheritance sites**:
  1. named-version objects (`:294-303` — currently `matchingAutoVersion?.authors || []`),
  2. the post-named fragment (`:335-341` — currently `{...autoVersion}` spread), and
  3. the pre-named fragment (`:349-357` — same spread).
  The `matchingAutoVersion` lookup survives ONLY as a timestamp fallback layer;
  authors never come from it again. `getVersionContent`'s auto-version meta path
  (`:540-553`) already groups the filtered set per range and is unaffected.
- **Rationale**: The spread copies the parent auto-version's `authors` and
  `onBehalfOf` onto ranges they don't describe — reproduced in BOTH directions
  (ledger N-041-1): naming a sub-range credits outside authors on the named
  version AND on every fragment. Computing from the range's own rows cures A1,
  the split fragments, and A7 (no dependence on finding a matching auto version)
  in one mechanism, exactly as RBD-041-4 intended. Passing the already-fetched
  filtered array keeps the timeline O(rows) — no new queries, no replay.
- **Alternatives considered**: (a) per-range SQL queries — N+1 queries per
  timeline render for data already in memory; (b) fixing only the named-version
  site — leaves the fragment half of the bidirectional lie (Sam's repro) in
  place; (c) building an interval index — overkill for one linear pass over an
  array that is already sorted by clock.
- **Callers checked**: `getVersionTimeline` (passes its filtered `updates`);
  the `mergeNamedVersions` export is also exercised directly by unit tests
  (update them); MCP `list_document_versions` and the REST history route both go
  through `getVersionTimeline` — no other production caller.

## R2 — Drill-down meaningful filter + honest counts (FR-004 / A2)

- **Decision**: In `getUpdatesForVersion` (`:754-792`): filter
  `updates.filter(u => u.meaningful !== false)` (explicit noise dropped, unknown
  kept — identical predicate to `:419` and `:540`) BEFORE grouping, and set each
  sub-version's `updateCount` to the number of surviving rows grouped into it
  (count rows during grouping or per-range after; NOT `clockEnd - clockStart + 1`).
  A small shared `isMeaningful(u)` helper replaces the three inline predicates
  (in-file; the report's C15 suggestion, taken here only because FR-004 requires
  the predicate in a third place).
- **Rationale**: The timeline and content paths already apply this rule; the
  drill-down is the one surface that doesn't, producing noise-only sub-groups
  and inflated counts (surfaces disagree — SC-002).
- **Alternatives considered**: filtering in SQL (`WHERE meaningful IS DISTINCT
  FROM false`) — would diverge from the shared JS predicate and split the D-3
  "NULL is kept" rule across two languages.

## R3 — Rendering the failure states (FR-005, FR-006 / B4)

- **Decision**: Split the hook's single `error` into `error` (timeline/CRUD) and
  `diffError` (preview loads — set where `selectVersion`/`selectUpdate` currently
  funnel into the shared `error`). Pass `error` + a `retry` (bound `fetchHistory`)
  into `VersionHistoryPanel`; render `.version-history-error` (CSS already at
  `VersionHistoryPanel.css:160-171`, currently dead) with a retry button, and gate
  the empty state on `!error` (empty text only for a successful zero-version
  response). Pass `diffError` into `VersionPreview`; when set, render an error
  state; the "Select a version to preview" placeholder renders only when
  `!selection` (today it renders whenever `diffData` is null — including after a
  failed load, which is the lie).
- **Rationale**: The hook already records failures (`useVersionHistory.js:92-97,
  190-196`) — nothing renders them; `EditorView.jsx` doesn't even destructure
  `error`. Splitting prevents a diff failure from erroring the whole list and
  vice versa (they have different retry affordances).
- **Alternatives considered**: one shared error — a failed diff would blank the
  timeline (worse than today); toast-only errors — vanish, leaving the lying
  empty state visible again.

## R4 — Selection reconciliation (FR-007 / A4)

- **Decision**: In the hook, reconcile inside `fetchHistory` (or an effect on
  `versions`) after every refresh: if a selection exists, find the version in the
  fresh list whose range contains the old selection's `clockEnd` (RBD-041-8);
  fall back to the default-selection rule (current version) when none contains
  it. If the resolved version differs from the held selection (id, range, name,
  `isCurrent`), update `selection` to the FRESH object and re-run the diff load
  only when the (clockEnd, previousClock) pair actually changed (avoids
  re-fetching an identical preview on every poll tick). Sub-version selections
  reconcile against the containing top-level version the same way. All actions
  (header restore `EditorView.jsx:218`, rename, delete) therefore operate on
  reconciled ids by construction — they read `selection`.
- **Rationale**: Header title (`EditorView.jsx:385`), contributors footer
  (`VersionPreview.jsx:79-92`), and restore gating (`:389`) all render from
  `selection`, which is a click-time snapshot today. One reconcile point in the
  hook fixes every consumer at once.
- **Alternatives considered**: reconciling in each component — N places to
  drift; keying selection by clockEnd only — loses named-version identity across
  renames (id survives rename; range containment covers resplits).

## R5 — Live-refresh mechanism (FR-008 / B5; plan-level per RBD-041-7)

- **Decision**: **Poll.** While the panel is open (`docGuid` non-null — the hook
  is already mounted only then, `EditorView.jsx:180`): `setInterval` calling
  `fetchHistory` every 10 s, skipping ticks while `document.hidden`, cleaned up
  on unmount. Poll responses flow through the same refresh path as CRUD
  (reconciliation R4, drill-down re-fetch R6), so scroll/expansions are
  preserved by those mechanisms; the poll must NOT clear `error` implicitly on a
  failed tick (last-good list stays; error state shows).
- **Rationale**: The version-history view replaces the editor surface — the
  collaboration provider's availability there is incidental, and a subscription
  path would couple the history panel to provider internals for no product
  gain (spec constrains outcome only). A 10 s poll of an O(rows) endpoint is
  negligible load and trivially testable with fake timers.
- **Alternatives considered**: y-websocket subscription (re-fetch on doc update
  events) — depends on the provider being connected in a view that doesn't
  otherwise need it, and still needs a fetch per event (the timeline is
  server-computed); SSE/WebSocket history channel — new surface, out of
  proportion.

## R6 — Expanded drill-downs re-fetch (FR-009 / B5)

- **Decision**: `HierarchicalVersionList` owns `expandedVersions` (`:367`); the
  hook wipes `versionUpdates` on refresh (`:90-91`). Add an effect in the list:
  for every version id that is expanded AND present in the fresh list AND has no
  cached `versionUpdates[id]` AND is not `loadingVersionUpdates[id]`, call
  `onLoadUpdates(version.clockStart, version.clockEnd, id)` with the FRESH
  range. Expanded ids no longer present in the list are dropped from
  `expandedVersions` (the version was resplit/deleted — edge case: expansions
  preserved only "where the version still exists"). The "No individual updates"
  empty text renders only when a load for that id has completed successfully
  with zero subversions (loading state already exists and must win).
- **Rationale**: Today the wiped cache + still-expanded row renders the false
  "No individual updates" until manually collapsed/re-expanded.
- **Alternatives considered**: lifting expansion state into the hook — larger
  refactor with no additional truth (042 territory).

## R7 — Bind refusal on load failure (FR-010 / B2; RBD-041-1)

- **Decision**: The catch at `server/index.js:469-474` is structurally a
  REAL-failure path: `persistenceProvider.getYDoc` returns an empty doc built
  from zero rows for a genuinely new document — it does not throw for "no rows".
  (Verify with a pin test: new-doc bind takes the success path.) New catch
  behavior: `notifyException(error, { source: 'bindState', extra: { docGuid } })`,
  log at error level (never the `NEW DOC` info line), mark the doc
  (`ydoc._bindFailed = true`), remove it from y-websocket's `docs` map
  (`docs.delete(docName)` — `docs` is exported by `y-websocket/bin/utils`), and
  close every connection on it with **close code 1013 (Try Again Later)**; the
  update listener (already attached above the load) must drop persist attempts
  while `_bindFailed` (belt-and-suspenders — closed conns should produce none).
  Clients: y-websocket's `WebsocketProvider` auto-reconnects on any close except
  the app's handled auth codes (4401/4403 — `useYjs.js`), so 1013 yields retry
  with backoff and the doc re-binds fresh (the deleted map entry) on the next
  attempt. Repeated failures during an outage: each retry produces one refused
  bind; rely on the exception notifier's existing dedupe conventions plus the
  reconnect backoff — no new rate limiter (edge case honored: no crash loop; the
  refused bind path allocates nothing persistent).
- **Rationale**: Fail-closed matches restore/undo posture (023 D-2); an evicted
  doc guarantees no half-bound empty doc lingers to accept edits; 1013 is the
  standard transient-retry close code and is not in the client's fatal set.
- **Alternatives considered**: binding a read-only doc — new degraded mode with
  its own truth problems (rejected in RBD-041-1); leaving the doc in the map
  with a poisoned flag — every later `getYDoc` returns the poisoned empty doc,
  which is exactly the lie being removed; retrying the load inline — the client
  retry loop already provides this with backoff.

## R8 — Restore delta from the live doc (FR-011 / B3; RBD-041-2)

- **Decision**: In `restoreVersion`: after the fail-closed reads, peek for a live
  doc on THIS instance (`peekSharedDoc`, R10). **Live path** (doc loaded here):
  run the existing delete-and-reclone replace inside `liveDoc.transact(fn,
  ORIGIN_RESTORE)`, capturing the transaction's own update bytes with an
  origin-scoped `update` listener (the exact capture discipline
  `document-service.updateDocument` uses); then `storeUpdate(captured, userId,
  agentName, ..., { meaningful: true })`. Broadcast needs no `applyLiveUpdate`:
  the live doc's own y-websocket `updateHandler` and (if attached) Redis handler
  fanned out at transact time — `ORIGIN_RESTORE` is deliberately not on the
  Redis skip-list; when no Redis handler was attached, `publishIfUnhandled`
  covers the replica case. The persistence listener skips `ORIGIN_RESTORE`
  (sentinel), so no double row. **Not-loaded path**: current behavior byte-for-byte
  (Postgres read → tempDoc delta → store → `applyLiveUpdate`), now with the R10
  peek making the "not loaded" branch genuinely reachable. **Residual** (recorded
  in the `restoreVersion` header + contracts/restore-live-delta.md): a doc loaded
  ONLY on another pod still takes the not-loaded path — cross-pod serialization
  is out of scope. **Ordering note**: the live path is broadcast-then-store,
  the same publish-before-commit shape every normal edit has (038 FR-018
  accepted posture; B1 stays closed) — document this in the same header.
- **Rationale**: The transaction closes the single-instance interleave window:
  the stored row is exactly the transition applied to the live doc, because it
  IS the live doc's transaction payload. Reuses two shipped mechanisms
  (origin-scoped capture, sentinel skip) instead of inventing locking.
- **Alternatives considered**: doc-level advisory lock spanning read→store —
  serializes against the persistence queue it must also flow through
  (deadlock-prone) and still doesn't cover other pods; full cross-pod lock —
  explicitly out of scope (RBD-041-2).

## R9 — Tail-completeness on restore's target read (FR-012 / B7)

- **Decision**: `getYDocAtClock(docGuid, clock, opts)` gains
  `opts.expectedTailClock`, forwarded to `_fetchRowsWithGapRetry` exactly as
  `getUpdateRowsUpTo` does (`:823-838`); `gapped` then means interior gap OR
  short tail. `getVersionContent` passes `expectedTailClock: clockEnd` ONLY on
  the `withGap: true` (stored-artifact/restore) path — safe against the CD-5/G5
  sentinel-clock hazard because `getVersionContent` validates `clockEnd` against
  the document's real min/max BEFORE the read (`:509-525`), so the value is a
  committed clock, never a MAX_CLOCK-style sentinel. Serving-only callers
  (preview, compare, `getContentAtClock`) are unchanged. Restore's existing
  `targetGapped` refusal (`:599-606`) then covers the short tail with zero new
  refusal logic.
- **Rationale**: The 039 mechanism exists and is proven on the diff path; this
  is the cheap, spec-mandated extension of it to the one stored-artifact reader
  that lacked it.
- **Alternatives considered**: post-read `rows[rows.length-1].clock === clockEnd`
  check in version-history.js — duplicates what `_fetchRowsWithGapRetry` already
  implements (including the retry budget), one layer up.

## R10 — Honest is-loaded probe (FR-013 / B8)

- **Decision**: `document-service.js` gains `peekSharedDoc(docGuid)` returning
  `docsMap.get('s/' + docGuid) || null` — NEVER creates. Wire the y-websocket
  `docs` map in via `documentService.init` (index.js:1917 currently passes the
  creating `getYDoc`; pass `docs` alongside — `docs` is already exported by
  `y-websocket/bin/utils` and re-exported from index.js's own exports block).
  Consumers switched to the peek: `undo-service.resolveDeps`'s default
  `getSharedDoc` (`undo-service.js:54-60`), the restore route's deps
  (`index.js:1531`), and the MCP restore tool's deps
  (`restore-document-version.js:94`) — i.e. every path whose question is "is
  this doc loaded?". `applyLiveUpdate` itself needs no change (it calls whatever
  `getSharedDoc` it is handed); its not-loaded branch and `no delivery path`
  warn become genuinely reachable. **Explicitly unchanged**: `getSharedDoc` for
  `updateDocument` (agent modify/import write path — creating there is that
  path's contract) and the WS connection-setup `getYDoc` call (index.js:2142 —
  setupWSConnection already created the doc). Verify no-leak with a test:
  restore/undo of an unloaded doc leaves `docs.size` unchanged.
- **Rationale**: y-websocket's `getYDoc` is `map.setIfUndefined(docs, ...)` —
  the lookup IS the creation (`bin/utils.js:146-155`), which also fires a
  spurious async `bindState` full load per operation. The exported `docs` map is
  the honest primitive already available.
- **Alternatives considered**: create-then-evict after the operation — racy
  against a real connection arriving mid-operation (would evict a doc in use);
  adding a `create=false` flag upstream in y-websocket — vendored-dependency
  patch for what a map lookup does.

## R11 — Pending-recording guard vs sync rows (FR-014 / B6)

- **Decision**: Add `AND via_sync IS NOT TRUE` to the newest-row probe in
  `hasPendingRecording` (`edit-records.js:191-196`). `IS NOT TRUE` keeps NULL
  (pre-038 rows, normal writes) matching — only flagged sync rows are excluded,
  per the uniform via_sync read rule (`postgres-persistence.js:_mapUpdateRow`
  contract comment).
- **Rationale**: A reconnect catch-up re-supplies rows under the agent identity
  with `via_sync=true`; those will never get an agent_edits record, so the
  guard's "newer than everything accounted" heuristic false-positives for up to
  the 60 s freshness window. One-line predicate fix, exactly as the report
  scoped it.
- **Alternatives considered**: none credible — the alternative comment-only
  form applies to FR-016 (R13), not here (this path is user-facing and
  reachable today).

## R12 — Verified "Reverted" stamp (FR-015 / A3 narrow; RBD-041-3)

- **Decision**: (1) `undo-service.performUndo` success result gains additive
  `undoneRecordRange: { clockStart, clockEnd }` from the claimed row's
  `editClockStart/editClockEnd`; `performRedo` symmetrically gains
  `redoneRecordRange` from the SAME fields (the original edit's range — that is
  what the card stores). (2) In `makeUndoRedoHandler` (index.js:1582-1589): on
  success with `chatId`+`toolCallId`, load the chat, find the part, read the
  card's recorded range at `part.output?.editRange` (the persisted modify result
  — feature 016 contract; verified: client reads the same field,
  `AiChatMessages.jsx` `part.output`), and stamp via `setChatPartReverted` ONLY
  when `card.clockStart === result.<range>.clockStart && card.clockEnd ===
  result.<range>.clockEnd`. On mismatch — including a card with NO stored
  `editRange` (pre-016 parts / editRangePending cards) — skip the stamp and log
  one structured warn line (`[undo] reverted-stamp skipped: card range X vs
  undone range Y`). The undo/redo result to the client is unchanged either way.
  Direct-API arbitrary `toolCallId` therefore cannot stamp an unrelated card.
  (3) NOTHING from the 040 D19 cut is touched: no restore-undo, no offer
  guards, no per-chat scoping — the verification is a read-and-compare at the
  stamp site only.
- **Rationale**: Cheapest truthful mechanism; the evidence (card range, record
  range) already exists on both sides, so this is pure comparison. Absence of
  evidence = mismatch (spec edge case: skip + log, never pass).
- **Alternatives considered**: per-chat undo scoping / offer guards —
  explicitly rejected in RBD-041-3 as product-behavior change / cut revival.
- **Note for implementer**: `setChatPartReverted` currently both finds and
  mutates; refactor minimally so the handler can read the part's range first
  (e.g. return the part or accept an expected range) without loading the chat
  twice.

## R13 — Spanning-fallback viaSync guard (FR-016 / B9; RBD-041-5)

- **Decision**: Take the GUARD (preferred by RBD-041-5): in `computeInverse`'s
  no-`clockSet` branch (`inverse.js:105-113`), a row with `viaSync === true` is
  never tracked as part of the edit (`inTarget && isIdentityRow(row) &&
  row.viaSync !== true`). Rows arrive with `viaSync` mapped
  (`_mapUpdateRow`). Mirrors `legacy.js:63`'s established rule (`viaSync ===
  true` breaks/excludes; NULL is normal). The clockSet path is untouched —
  exact clock sets come from the recorder, which never records sync rows.
- **Rationale**: Enforced invariant beats asserted comment; the guard is one
  boolean test on data already present and cannot change behavior for any row
  that could legitimately be in a recorded edit (recorded edits' clocks are
  never sync rows).
- **Alternatives considered**: load-bearing comment (RBD-041-5's fallback) —
  keep in reserve only if the guard provably alters a legacy-row scenario;
  write a test demonstrating it doesn't (sync row inside a legacy spanning
  range is not inverted).

## R14 — Loud null/primitive origin fallback (FR-017 / A5; RBD-041-9)

- **Decision**: `parseOrigin`'s final fallback (`origin.js:186`) returns
  `{ userId: null, agentName: null, malformedOrigin: 'null-or-primitive' }` plus
  a `console.error` mirroring the non-uuid-string one (include `typeof origin`
  and a stringified slice; logging wrapped so it can never break persistence).
  The bindState listener's notification branch (index.js:328) extends to page
  on `'null-or-primitive'` exactly as it pages `'non-uuid-string'`
  (`notifyException`, source `origin-parsing`). `'unrecognized-object'` keeps
  its current warn-only treatment — FR-017's scope is the null/primitive class.
  **The "marker" is the in-memory `malformedOrigin` classification field —
  parity with the existing classes — NOT a new DB column** (RBD-041-9: no
  schema change, no migration; no consumer reads a persisted marker, and the
  loudness contract lives in the log + notification, same as 038 built).
- **Rationale**: A null/primitive origin means a server-side caller passed
  nothing down the attribution path — same defect class and severity as a
  non-UUID string, so it gets the same page. The path is believed
  near-unreachable (report A5); if a hot internal transact-without-origin ever
  appears, the page makes it visible on first occurrence instead of silently
  accumulating unattributed rows.
- **Alternatives considered**: persisted marker column — a migration (spec and
  pipeline both expect none) for a field nothing reads; folding into
  `'unrecognized-object'` — erases the distinction the spec demands ("distinct
  malformed-origin marker").

## R15 — Documentation truth sweep (FR-018, FR-019 / D3–D5)

- **Decision**: Three surfaces, post-040-D19 wording:
  1. `server/agent-identity.js:18-30` — CHAT_AGENT_NAME docstring stops claiming
     web-UI restores are recorded under it; describes actual uses (chat modify
     edits; chat undo/redo endpoints resolve the same identity).
  2. `server/undo/edit-records.js:24-46` sentinel-rule comment — already
     partially updated by 040's cut; strike/replace any remaining "is what a
     human web-UI restore now records under"-era phrasing so the comment reads
     cleanly as: chat-assistant identity = the assistant's OWN modify edits
     only.
  3. `server/mcp/tools/restore-document-version.js:28-49` description — state
     that an agent's restore is itself a recorded edit which that agent's own
     `undo` tool can invert (in addition to counter-restore); currently it
     offers ONLY counter-restore ("you can undo it by restoring to a version
     from before the restore"), understating the 023 FR-020 behavior that
     survived the cut.
  Also add the FR-011 residual-limitation sentence to `restoreVersion`'s header
  (R8) — same sweep, same commit.
- **Rationale**: Constitution I + Principle I rationale — agents take these
  surfaces literally; SC-011 requires zero pre-cut claims.

## R16 — Noise-only named range fallback (edge case of FR-001/003)

- **Decision**: `computeRangeMeta` computes from the meaningful-filtered rows in
  range first; if the range contains rows but ALL were noise-filtered, fall back
  to computing from the UNFILTERED rows of that same range (their real authors,
  Unknown-author rule applying); an empty author list is produced only when the
  range contains no rows at all. Timestamp follows the same two-step rule.
- **Rationale**: FR-003 permits an empty list only for a genuinely row-less
  range; a noise-only range demonstrably has editors, and crediting them (from
  inside the range) satisfies "never a crash, never a phantom author from
  outside the range". The fallback set is by construction range-scoped, so the
  attribution promise holds.
- **Alternatives considered**: empty list for noise-only ranges — violates
  FR-003's letter; keeping noise rows in the primary computation — would make
  named-version authors diverge from the timeline's keep-unknown/drop-noise
  rule in the common case.
