# Quickstart Validation — 041-version-history-truth

Prerequisites: repo at main with 041 implemented; backend test stack per
`docs/dev.md` (in-pod) or the local pg+pgvector+redis stack. **Backend suites
run SERIALLY against one DB** — never in parallel. Client suites run under
Vitest.

## Run the affected suites

```bash
# Backend (serial; from repo root)
npx jest server/__tests__/version-history.test.js \
         server/__tests__/version-history-api.test.js \
         server/undo/__tests__ \
         server/__tests__/origin.test.js \
         --runInBand

# Integration (serial)
npx jest __tests__/integration --runInBand

# Client
cd client && npx vitest run src/hooks/__tests__ src/components/__tests__
```

(Exact new test filenames are fixed in tasks.md; suites above are the homes.)

## FR → validation matrix

| FR | Validation (automated unless noted) |
|---|---|
| FR-001/002/003 | **Bidirectional split regression (pinned per ledger N-041-1)**: user A edits clocks 1-5, user B clocks 6-10 in one burst; name a version over 1-5. Assert: named version lists ONLY A (+creator badge); fragment 6-10 lists ONLY B; and the mirrored case (name 6-10) shows only B on the named range and only A on the fragment. Plus: named version with noise-classified boundary row resolves authors+timestamp from its own range (A7); noise-only range falls back to unfiltered in-range rows; row-less range → empty authors; onBehalfOf scoped per fragment. |
| FR-004 | Range containing noise rows: drill-down emits no noise-only sub-group; each `updateCount` counts only surviving rows; Σ drill-down counts == timeline accounting for the range (SC-002). |
| FR-005 | Hook/panel test: failed `/history` → error state + working retry rendered; "No version history yet" ONLY on successful empty response. |
| FR-006 | Failed diff load with a selection → preview error state; placeholder only when nothing selected. |
| FR-007 | After rename/mid-range naming refresh: selection re-resolves (containing clockEnd → else default); header title/contributors/isCurrent/restore-gating read fresh data; header restore posts a POST-split id (SC-005); deleted selection re-resolves, never acts on the stale id. |
| FR-008 | Fake timers: poll ticks call fetchHistory every 10 s while open, not when hidden; new collaborator edit appears without reopen (SC-006); poll failure keeps last-good list + error state. |
| FR-009 | Expanded row + refresh that wipes the cache → re-fetch fires with the FRESH range; "No individual updates" only after a successful empty response; expanded id missing from fresh list is dropped. |
| FR-010 | bindState with throwing persistence: notifier paged, doc evicted from docs map, conns closed 1013, no `NEW DOC` log; zero-rows doc still binds normally (pin test); no empty doc served over an outage (SC-004). |
| FR-011 | Restore with live doc on instance while a concurrent transaction lands: stored row == the transition applied to the live doc (no invisible interleave); single stored row (sentinel skip); fan-out fired once. Not-loaded path byte-identical to today. |
| FR-012 | `getYDocAtClock` with `expectedTailClock` on a short-tail log reports gapped; restore refuses (503/DocumentSyncingError), nothing stored (SC-009b); serving reads unchanged. |
| FR-013 | Restore + undo + redo of a doc loaded nowhere: y-websocket docs map size unchanged after completion (SC-009a); peek never creates. |
| FR-014 | Newest identity row is `via_sync=true` and fresh: undo-status and undo proceed (no "still being recorded"); genuine pending-recording still guards (SC-007). |
| FR-015 | Card with matching `output.editRange` → stamped. Card whose range ≠ undone record (cross-chat shape) → NOT stamped + warn logged. Card with NO stored range → not stamped + logged. Arbitrary toolCallId via direct POST → unrelated card never stamped (SC-008). Redo symmetric. HTTP result identical either way. |
| FR-016 | computeInverse spanning fallback (no clockSet): identity row with `viaSync=true` inside the range is NOT inverted; behavior with legacy non-sync rows unchanged. |
| FR-017 | `parseOrigin(null)`, `parseOrigin(42)`, `parseOrigin(true)` → `malformedOrigin: 'null-or-primitive'` + error log; bindState listener pages it like non-uuid-string; row persists unattributed (SC-010). `unrecognized-object` treatment unchanged. |
| FR-018/019 | Doc-truth sweep (grep-based test or review checklist): agent-identity docstring, edit-records sentinel comment, MCP restore description contain no pre-cut claims; restore description states agent-restore-is-undoable (SC-011). |

## Manual checks (owed to Sam post-merge, list for the merge report)

1. Open version history with the API blocked (devtools offline): error + retry
   render; retry works after unblocking. Repeat for a selected version's diff.
2. Two-browser: name a mid-range version from session B while session A has the
   panel open + a version selected → A's header/contributors/restore update
   within one poll cycle; expanded rows repopulate; scroll position survives.
3. Chat: modify → Undo from the card (stamps), redo (unstamps); then the
   cross-chat shape (two chats, newer edit in chat 2, undo from chat 1's card)
   → chat 1's card does NOT say Reverted; server log shows the skip line.
4. Restore a version from the web UI while typing in another browser: no lost
   keystrokes, history shows the restore under the human, no Undo offered for
   it (design amendment intact).

## Success gates
- All suites above green, serially.
- Zero regressions in the untouched restore/undo suites.
- `git grep -n "web-UI restore" server/ | grep -v spec` shows only post-cut
  wording.
