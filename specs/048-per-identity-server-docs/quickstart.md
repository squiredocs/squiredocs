# Quickstart — validating 048-per-identity-server-docs

Validation guide for the implementer and the merge queue. Implementation
details live in tasks.md and the contracts; this file is how you PROVE it.

## Prerequisites

- Backend test stack (pg + pgvector + redis + env) per the standard local
  setup; backend suites are **serial-only on the shared DB** — never run two
  backend runs concurrently. **During the plan/analyze window a suite run was
  already in progress; coordinate before running.**
- No migration to apply (048 is code-only).

## Commands

```bash
# Focused (fast inner loop)
npx jest server/__tests__/per-operation-doc.test.js --runInBand
npx jest server/__tests__/document-service-capture.test.js server/__tests__/import-presence.test.js server/__tests__/live-fanout.test.js server/__tests__/document-titles.test.js server/__tests__/bindstate-failure.test.js --runInBand
npx jest server/__tests__/resupply-resolution.test.js --runInBand

# Restore + undo integration
npx jest __tests__/integration --runInBand -t "restore"
npx jest __tests__/integration --runInBand -t "undo"

# Authoritative gate (merge queue): full backend suite, serial
npm test -- --runInBand
```

## Validation scenarios → requirement matrix

| Scenario | Proves | Where |
|---|---|---|
| Each of the six operations emits a fresh clientID ≠ shared doc's; consecutive ops distinct | FR-001/002/003, SC-001, US1-AS1/AS2 | guards G1–G3 (contracts/invariant-guards.md) |
| `updateFn` receives a non-shared doc | FR-007b, US3-AS3 | G4 |
| Throwing `updateFn` leaves the doc byte-identical, no row | FR-006, SC-005, US1-AS5 | G5 |
| Cold-doc title set survives the in-flight load; append lands at the end; bind-refusal and timeout fail the call | FR-013 (RBD-048-4) | H1–H5 |
| Capture/return/fan-out/presence contracts unchanged | FR-005, FR-010, SC-003 | contract-preservation suites |
| Restore: one row, stored bytes === broadcast bytes, loaded AND not-loaded | FR-004, US2-AS1/AS2 | restore suites + G2 |
| Restore ordering: store-then-apply; concurrent edit merges; commit-without-broadcast replays | RBD-048-2, US2-AS3/AS4 | restore suites |
| MCP restore still undoable; human restore still not an undo target | US2-AS5 | restore/undo integration |
| Import + title set through new mechanism undoable | FR-009, SC-003 | U1/U2 |
| Undo-inverse and sync-push patterns pinned | FR-007, US3-AS4 | P1/P2 |
| Resolver's three sources still wired | FR-008, US3-AS5 | P3 |
| Lost-then-resupplied server write → "Synced content" everywhere; identical answers cross-process | SC-001/SC-002, US1-AS3/AS4 | resupply honesty tests |
| Deliberate regression (scratch branch: direct transact on shared doc) makes guards FAIL | SC-004, US3 independent test | review-time check, not committed |

## Expected outcomes

- Full backend suite green, serially.
- The guard suite fails loudly on a deliberate shared-doc transact (verify
  once at review time on a scratch change, then discard).
- No new listener leaks (listener-count assertions in the capture suite).
- Grep check for FR-011: `grep -a "transacts on the ONE live" server/ -r`
  returns nothing (the falsified claim is gone).

## What NOT to validate here

- Multi-replica behavior: M3/M4 remain open; the one-replica deploy
  constraint stands (FR-012). Nothing in this feature is a scale-out test.
- Performance: costs are accepted by design (research R12); no benchmark gate.
