# Contract — the invariant guard & pinning suite (FR-007, FR-013, US3)

The invariant: **the shared server doc's own clientID never authors a content
operation; everything reaching the shared doc is pre-encoded bytes.** Pinned
three ways: Jest guards (below), a unit test on the updateFn argument, and the
retained live-peek production tripwire (RBD-048-3).

Primary home: `server/__tests__/per-operation-doc.test.js` (NEW), plus
targeted additions to existing suites. Extraction technique everywhere:
`[...Y.parseUpdateMeta(update).to.keys()]` — the exact insert-set reading the
resolver uses (verified against yjs 13.6.30).

## Guards (must FAIL on regression — SC-004 requires a deliberate-regression check at review)

| # | Assertion | Target |
|---|---|---|
| G1 | Emitted update's insert set never contains `sharedDoc.clientID` | `updateDocument` (each of: content insert, meta title set, seeded create) |
| G2 | Same, for `restoreVersion` (both trusted-live and durable seeds) | restore suites |
| G3 | Two consecutive `updateDocument` calls emit two DISTINCT clientIDs (never reused) | new suite |
| G4 | The doc passed to `updateFn` is `!==` the shared doc; mutations do not appear on the shared doc until the merge | new suite (unit) |
| G5 | Throwing `updateFn`: error propagates, shared doc byte-identical (state vector + encoded state equal), no row initiated | new suite (FR-006/SC-005) |
| G6 | No-change `updateFn`: zero return value, no row, no armed listener leaks (listener-count check as in the 038 capture suite) | new suite |

## The half-loaded test class (FR-013, RBD-048-4 — the orchestrator-mandated missing class)

Fake `getYDoc` returning a doc with `_bindComplete` unset; "persisted" state
(title + body) applied after a delay, then `_bindComplete = true`:

| # | Assertion |
|---|---|
| H1 | A title set through `updateDocument` on the cold doc ALWAYS survives the late-arriving persisted title (the pre-fix repro loses ~half by Y.Map LWW) |
| H2 | An append-shaped insert lands AFTER the persisted content, never at index 0 |
| H3 | `_bindFailed` set while the gate waits → `BindFailedError`, shared doc untouched, no row |
| H4 | A doc that never binds → the timeout error, no write |
| H5 | Warm doc (`_bindComplete` already true) → no observable wait (fast path) |

## Contract-preservation (FR-005 — existing suites, adjusted not weakened)

- `document-service-capture.test.js`: origin-scoped capture, emit-time
  `hadRedisHandler`, exact-bytes-reproduce-the-change, synchronous
  detachment — all must still pass with fakes marked `_bindComplete = true`.
- `import-presence.test.js` / `live-fanout.test.js` / `document-titles.test.js`:
  unchanged observable semantics through the new mechanism.
- `bindstate-failure.test.js`: post-merge `BindFailedError` retained; plus the
  gate's pre-seed refusal (H3).

## Pinning the already-conforming patterns (FR-007 second half — drift alarms)

| # | Assertion | Where |
|---|---|---|
| P1 | Undo/redo inverse: store-then-apply, inverse update's insert-set clientID is the scratch doc's own one-shot ID (never the live doc's) | beside existing undo suites |
| P2 | Sync push: `fork.clientID === syntheticClientId(docGuid, baselineClock, sha256(md))` pinned BEFORE any op; identical push → byte-identical update (the documented exception) | sync-push suites (extend only if not already asserted) |
| P3 | Resolver wiring: live-peek source, `CHAT_AGENT_NAME` durable-stamp source, and 2+ identity ambiguity source ALL still active (nothing deleted at cutover, FR-008) | `resupply-resolution.test.js` |

## Undoability regression (FR-009)

| # | Assertion | Where |
|---|---|---|
| U1 | An agent import through the new mechanism is undoable exactly as today | integration |
| U2 | An agent title set through the new mechanism is undoable exactly as today | integration |

(Identity predicates match on row stamps + `via_sync` guard, never clientIDs —
these tests prove no production change is needed and alarm if a predicate ever
starts reading clientIDs.)

## Resupply honesty (US1 AS-3/AS-4, SC-001/SC-002)

End-to-end: a server-side write under a plain user identity, lost after
broadcast and resupplied via a browser sync handshake, resolves as the honest
"Synced content" on a process with NO shared in-memory state with the writer —
never another user; and two processes resolve the same post-cutover rows
identically. (Builds on the 045/047 resupply test scaffolding.)
