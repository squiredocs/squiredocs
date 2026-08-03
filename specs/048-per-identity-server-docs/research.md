# Research — 048-per-identity-server-docs

Phase 0 mechanism decisions. Every decision below was made against the working
tree at plan time (2026-08-03, `main` @ 8cf10937) with the ratified design
section (`design/collaboration-core.md`, "Per-identity server docs",
committed 6db8b761) as ground truth. Anchors were located by symbol, not by
stale line numbers.

---

## R1 — Five of the six converging paths already route through `updateDocument`; the mechanism change is therefore one function

**Decision**: implement FR-001/FR-003 paths 1–5 entirely inside
`documentService.updateDocument` (`server/document-service.js`). No call-site
changes for those paths.

**Rationale**: the traced call-site inventory confirms the design's claim:

- Markdown import one-transaction write — `server/markdown-import.js:321` → `updateDocument`
- Document seed — `createSeededDocument` (`server/document-service.js:198`) → `updateDocument`; callers: `server/onboarding.js:50`, `server/api/docs-import.js:333/343`, `server/api/chat-tools.js:94`, `server/mcp/tools/create-document.js:172`
- Title set — `server/mcp/tools/set-document-title.js:79` → `updateDocument`
- Empty-import anchor — `server/api/chat-tools.js:60`, `server/api/docs-import.js:367`, `server/mcp/tools/create-document.js:197` → `updateDocument`
- Chat image insert — `server/api/chat-tools.js:108` → `updateDocument`

Path 6 (restore live path) is separate machinery in
`server/version-history.js` (`restoreVersion`, live branch ~lines 1039–1071)
and is handled by R6.

**Alternatives considered**: per-call-site ephemeral docs — rejected; the
design names `updateDocument` as "the one implementation point", and one owner
is what makes the invariant pinnable.

## R2 — Ephemeral-doc capture: a listener on the ephemeral doc, attached AFTER the seed

**Decision**: inside `updateDocument`, after seeding the ephemeral doc, attach
an `update` listener to the EPHEMERAL doc, run
`eph.transact(() => updateFn(eph), origin)`, detach in `finally`, then destroy
the ephemeral doc; if bytes were captured, merge with
`Y.applyUpdate(sharedDoc, bytes, origin)`.

**Rationale**:
- The seed itself (`Y.applyUpdate(eph, Y.encodeStateAsUpdate(sharedDoc))`)
  fires the ephemeral doc's `update` event, so the capture listener MUST be
  attached only after the seed — otherwise the seed bytes would be captured as
  "the operation".
- Yjs fires doc `update` events synchronously at transaction end (the exact
  property the current shared-doc capture already relies on), so by the time
  `transact` returns the bytes exist or never will (no-change).
- A no-change `updateFn` produces no event → no merge, no shared-doc event,
  and `updateDocument` returns the zero value exactly as today.

**Alternatives considered**: state-vector diff
(`Y.encodeStateAsUpdate(eph, svBeforeTransact)`) — equivalent for a fresh
single-transaction doc, but the design says "capture that transaction's update
bytes", the listener is the established house pattern, and the diff form costs
an extra encode on the no-change path just to discover it is empty.

## R3 — The shared-doc origin-scoped capture and the 037/038 return contract are preserved verbatim

**Decision**: keep the existing origin-identity-scoped `update` listener on
the SHARED doc (`updateHandler`, `server/document-service.js:114`) wrapped
around the merge. The merge `Y.applyUpdate(sharedDoc, bytes, origin)` fires
the shared doc's `update` event synchronously with this call's origin object,
so `captured = { update, hadRedisHandler }` (with `hadRedisHandler` sampled at
emit time), the `setImmediate` persistence-initiated hop, and the post-merge
`_bindFailed` → `BindFailedError` check all keep working unchanged.

**Rationale**: FR-005 requires the return contract, the origin-object-identity
scoping, the persistence-listener stamping, `via_sync` unset, and fan-out
behavior byte-identical. All of them are driven by the shared doc's `update`
event, which the merge still fires with the same origin object. Consumers that
depend on this: `import-presence.js` (origin-filtered observation + settle
timing after the `setImmediate` hop), `publishIfUnhandled` callers
(`markdown-import.js`, `docs-import.js`), `live-fanout` semantics.

**Note on bytes**: the shared doc re-encodes the applied transaction when
emitting, so `captured.update` may not be byte-identical to the ephemeral
capture — but it is struct-identical (same clientID, same content), and it is
the SHARED doc's emission that persistence, Redis and the return value have
always consumed. Nothing compares the two encodings.

## R4 — The bind-readiness gate: an awaitable `_bindComplete` poll owned by `document-service` (the orchestrator-verified half-loaded fix)

**Context (post-spec finding, orchestrator-verified 2026-08-03)**:
`updateDocument` transacts on a half-loaded doc for any cold document —
y-websocket's `getYDoc` fires `bindState` without awaiting it, so on a doc
nobody has open `getSharedDoc` returns an EMPTY doc and the write lands before
the persisted state merges on top. Reproduced with the repo's own yjs: a title
set on a cold doc loses ~half the time (98/200 trials, Y.Map LWW against the
later-arriving persisted title); a chat-image "append at end" lands at index 0
— before the whole document. The 048 seeding mechanism inherits this verbatim:
seeding from an empty shared doc reproduces it exactly. The design section
says "seed it by applying the shared doc's current encoded state" and is
SILENT on load completion; its own correctness claims (behavior-identical
operations, "a half-loaded doc is exactly as visible to updateFn as it is
today" — today being a state the adversarial review just proved buggy) are
only consistent with the loaded-state reading. Recorded as RBD-048-4
(RATIFIED-BY-DEFAULT) in `clarifications-needed.md`.

**Decision**: add `waitForDocReady(ydoc, docGuid, timeoutMs = 5000)` to
`server/document-service.js` and make it the ONE owner of the "is this doc
safe to write through?" question:

- fast path: `ydoc._bindComplete === true` → resolve immediately (warm docs
  pay nothing);
- `ydoc._bindFailed` → throw `BindFailedError(docGuid)` (same class the
  post-merge check throws — callers already handle it);
- otherwise poll every 10 ms until the deadline; on timeout throw
  `Error("Timed out waiting for document <guid> to load")` (the message shape
  `waitForDocLoaded` already uses, so route-level 500 mapping is unchanged).

`updateDocument` awaits this gate BEFORE the seed. The seed→transact→merge
sequence stays synchronous with no awaits between them (FR-001) — the gate
sits strictly before it.

**Consolidation (the three divergent predicates → one owner)**:

1. `_bindComplete` (set at `server/collab-bind-state.js:309`, consumed by
   `live-doc-trust.js`) — becomes the gate's substrate; `collab-bind-state.js`
   is NOT modified (no new coupling, no harness mirror churn).
2. `waitForDocLoaded`'s state-vector poll (`server/api/docs-import.js:214`) —
   DELETED; the route calls `documentService.waitForDocReady` instead. The
   state-vector poll costs an extra `persistence.getYDoc` DB read per call and
   answers a strictly weaker question (state coverage, not bind success — it
   spins to timeout on a failed bind where the gate throws `BindFailedError`
   immediately). With the gate inside `updateDocument`, the route-level call
   is retained because the route reads doc state BEFORE `updateDocument` runs
   (the append-mode presence baseline capture); the call is unconditional on
   the PUT route (append and replace), and belt-and-braces is fine since the
   second wait is a no-op flag check.
3. Nothing (`updateDocument` today, checking only `_bindFailed` after the
   fact) — gains the gate.

`live-doc-trust.js` (`isTrustedLiveDoc`) is NOT collapsed into the gate: it
answers a different question ("may I compute a durable artifact from this live
copy?" — requiring `_bindComplete` AND ≥1 live connection) and is a snapshot
predicate, not a wait. It already consumes the same `_bindComplete` flag, so
the substrate is shared; the questions stay distinct on purpose.

**Alternatives considered**:
- A promise stored on the ydoc by `bindState`
  (`ydoc._whenBindComplete`) — cleaner in the abstract, rejected: it modifies
  the binder and every harness/test that mirrors it, couples the gate's
  liveness to binder bookkeeping, and buys nothing over a bounded poll on a
  path that is only ever cold-doc-slow (warm docs short-circuit on the flag).
- Reusing `waitForDocLoaded`'s state-vector poll as the shared gate —
  rejected: extra DB read per write, blind to `_bindFailed`, and it would keep
  the predicate divergence this fix exists to end.
- Doing nothing (the spec's original edge-case text) — falsified by the
  reproduction; see RBD-048-4.

**Test-harness impact**: unit suites that drive `document-service` through its
`init` seam with a plain `Y.Doc`
(`server/__tests__/document-service-capture.test.js`,
`document-titles.test.js`, `live-fanout.test.js`,
`import-presence.test.js`, …) must mark their fakes `_bindComplete = true` in
setup — that is the honest statement "this test doc is fully loaded", not a
workaround. The integration harness
(`__tests__/integration/helpers/collab-harness.js`) uses the real
`createBindState`, which sets the flag itself.

## R5 — The missing test class: `updateDocument` against a doc whose bindState has not completed

**Decision**: add a deterministic regression test that reproduces the
half-loaded hazard and proves the gate closes it. Shape: a fake `getYDoc`
whose doc starts unmarked (`_bindComplete` unset) with a "persisted" title/body
applied only after a delay (simulating the un-awaited `bindState`), then
`_bindComplete = true`. Assertions:

- a title set through `updateDocument` on the cold doc ALWAYS survives the
  late-arriving persisted state (the pre-fix repro loses it ~half the time to
  Y.Map LWW);
- an append-shaped insert lands AFTER the persisted content, never at index 0;
- `_bindFailed` set while waiting → the call rejects with `BindFailedError`
  and the shared doc is untouched;
- a doc that never binds → the timeout error, no write.

**Rationale**: this is the test class the 046 work built the predicate for but
never pointed at `updateDocument`; without it the gate can rot silently.

## R6 — Restore unification: one ephemeral-doc path, store-then-apply, one broadcast call

**Decision**: rewrite `restoreVersion`'s branch structure
(`server/version-history.js:971`) as:

1. Unchanged: target-version read, current-state read via
   `persistence.getYDoc(docGuid, { withGap: true })`, and the F3 gap refusal
   (`DocumentSyncingError`) — the fail-closed read posture is not touched.
2. Choose the seed source: peek the live doc (non-creating), and if
   `isTrustedLiveDoc(liveDoc)` seed from `Y.encodeStateAsUpdate(liveDoc)`;
   otherwise (not loaded / `bind-incomplete` / `no-connections`, with the
   existing `untrustedReason` warn log) seed from the persisted `currentYdoc`.
3. One compute path: fresh ephemeral `Y.Doc`, apply seed,
   `svBefore = Y.encodeStateVector(eph)`, `eph.transact(applyRestoreTo)`,
   `restoreUpdate = Y.encodeStateAsUpdate(eph, svBefore)`, destroy.
   (This is today's durable-log path generalized to a trusted-live seed; the
   default-gc temp doc and the empty-delta no-change semantics are exactly
   what the durable path ships today.)
4. Store FIRST: `persistence.storeUpdate(...)` → `newClock`; then the
   unchanged agent-only `editRecords.recordEdit`.
5. Broadcast: `applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid,
   restoreUpdate, ORIGIN_RESTORE, 'Restore')` — for BOTH cases. Loaded here →
   applies to the live doc (which no longer has the update, since the
   transaction ran on the ephemeral doc) and fans out via the attached handler
   or the explicit publish (H1 double-send guard inside `applyLiveUpdate`);
   not loaded → publishes to Redis; neither → the never-silent warn (D-5).

**Deleted**: the live-path capture machinery — `captureHandler`,
`stateVectorBeforeRestore` on the live doc, the `liveCapture` variable, the
live-path `transact` on `liveDoc`, and the `publishIfUnhandled` branch (and
its import, if `version-history.js` no longer uses it elsewhere — it does
not).

**Rationale**: this is FR-004 verbatim, and it aligns restore with the
already-conforming store-then-apply patterns (undo inverse, sync push). The
041 invariant holds trivially: the stored bytes ARE the bytes handed to
`applyLiveUpdate`. The two accepted consequences (RBD-048-2): the crash window
flips to commit-without-broadcast (the durable row replays on next load —
`applyLiveUpdate` is already non-fatal-by-design after the row is durable),
and an edit landing during the store await merges with the restore (the
semantics the durable path and cross-pod restores already have).

**Alternatives considered**: keeping the trusted-live transact with a
post-hoc store — rejected by the design ("the live path stops transacting on
the live doc"); it is also the branch that kept the capture machinery alive.

## R7 — Invariant guards: `Y.parseUpdateMeta` insert sets, distinct-clientID assertions, and a not-the-shared-doc unit test

**Decision** (FR-007a/b): a new guard suite
(`server/__tests__/per-operation-doc.test.js`) asserts, for `updateDocument`
and `restoreVersion`:

- `[...Y.parseUpdateMeta(update).to.keys()]` (insert-set clientIDs — the exact
  extraction `resupply-resolution.js` uses, verified against yjs 13.6.30)
  never contains `sharedDoc.clientID`;
- two consecutive operations emit updates with two DISTINCT clientIDs;
- the doc passed to `updateFn` is `!==` the shared doc (and mutating it does
  not mutate the shared doc until the merge).

**Rationale**: `parseUpdateMeta` walks structs only (never the delete set), so
the insert-set reading is the same authorship semantics the resolver itself
uses — the guard tests the exact property the resolver depends on.

## R8 — Pinning the already-conforming patterns (FR-007's second half)

**Decision**: add pinning tests, not rework:

- Undo/redo inverse (`server/undo/inverse.js`): assert the inverse update's
  insert-set clientID is the scratch doc's own (one-shot, not the live doc's)
  and that the flow is store-then-apply. Lives beside the existing undo
  suites.
- Sync push (`server/markdown-sync.js`): assert `fork.clientID` is pinned to
  `syntheticClientId(docGuid, baselineClock, sha256(md))` BEFORE any op
  (existing behavior at ~line 1110) and that identical pushes are
  byte-identical — the documented exception to the random-clientID rule.
  Extend the existing sync-push suites only if this exact pin is not already
  asserted there.

## R9 — Resolver transition: nothing deleted; wire-state pinned by test

**Decision** (FR-008): no code changes to `server/resupply-resolution.js`'s
three sources. Add/extend a wiring assertion (in
`server/__tests__/resupply-resolution.test.js`) that all three remain active:
the live-peek source (`init({ peekSharedDoc })` from `server/index.js`), the
durable `SHARED_DOC_WRITER_AGENTS`/`CHAT_AGENT_NAME` stamp source, and the 2+
identity ambiguity source. The live peek is demoted in DOCUMENTATION to
"fail-honest tripwire" (see R10); deleting it is recorded cleanup (RBD-048-3),
not this feature.

## R10 — FR-011 comment corrections: the two falsified records

**Decision**: rewrite in place, same effort:

- `server/resupply-resolution.js` lines ~80–125 ("The shared server doc"
  block): the claim "Every server-side write path (`updateDocument`, and the
  live-doc restore clone) transacts on the ONE live `WSSharedDoc`" becomes a
  past-tense account: before 048 those paths did; after 048 every server-side
  operation authors under a one-shot ephemeral clientID, the live-peek source
  is a defense-in-depth tripwire (RBD-048-3), residuals R1/R2 are closed for
  post-cutover rows, and pre-cutover rows keep the old shapes.
- `server/version-history.js` restore header (~lines 936–956): the "WHERE THE
  STORED DELTA COMES FROM" block and residual 2 (ORDERING:
  broadcast-then-store) are rewritten to the unified ephemeral-doc,
  store-then-apply account (RBD-048-2); residual 1 (RBD-041-2 cross-pod) is
  kept verbatim.
- `server/document-service.js` header comments (the getSharedDoc write-path
  warning, the capture commentary) updated to describe the gate + ephemeral
  mechanism.

Note: `server/resupply-resolution.js` contains non-UTF8 bytes (`grep` treats
it as binary — use `grep -a` when searching it); edits must preserve the
file's existing encoding quirks (edit surgically, do not re-encode the file).

## R11 — Undoability regression coverage (FR-009)

**Decision**: integration-level tests that an import and a title set performed
through the new mechanism remain undoable exactly as today. The identity
predicates (`isSameIdentity`, row stamps + `via_sync` guard) never read
clientIDs, so no production change is expected — the tests exist to prove it
and to catch any future predicate that starts reading clientIDs.

## R12 — Performance and state-vector growth: accepted, not gated

**Decision**: no benchmarks, no gate. O(doc size) seed per operation and one
permanent state-vector entry per operation are accepted by the ratified design
("Costs, accepted"); the pooled per-identity doc is the recorded follow-on if
profiling ever shows a hot path. The gate's poll (R4) adds latency only to
cold-doc writes, bounded by the same load the operation had to wait for anyway
(previously it raced it and sometimes lost the race's data).
