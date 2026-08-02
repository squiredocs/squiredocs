# Data Model — 041-version-history-truth

No schema changes. No migrations. Every entity below already exists; this
feature changes how derived fields are COMPUTED and which in-memory fields are
carried. Column lists show only fields this feature touches.

## Persisted entities (unchanged schemas)

### `yjs_updates` (edit row)
| Field | Type | Role in this feature |
|---|---|---|
| `doc_guid`, `clock` | PK | The shared version coordinate; all range scoping keys on `clock`. |
| `user_id`, `agent_name` | attribution | Range-scoped author computation (FR-001..004); Unknown-author rule when `user_id` NULL. |
| `on_behalf_of` | jsonb | Sync-push provenance — now scoped per range/fragment, never inherited (FR-002). |
| `meaningful` | bool/null | Filter rule everywhere: only explicit `false` dropped; NULL kept (D-3). Drill-down now applies it (FR-004). |
| `via_sync` | bool/null | Now ALSO consumed by: pending-recording guard (`IS NOT TRUE`, FR-014) and `computeInverse` spanning fallback (`=== true` never tracked, FR-016). Read rule unchanged: only `true` means sync. |

**Not added**: a persisted malformed-origin column. The FR-017 "marker" is the
in-memory `parseOrigin` classification (RBD-041-9).

### `agent_edits` (edit record)
| Field | Role |
|---|---|
| `edit_clock_start`, `edit_clock_end` | The recorded edit's range — now surfaced additively on undo/redo results as `undoneRecordRange`/`redoneRecordRange` for stamp verification (FR-015). |
| `state`, claim CAS | Untouched. Human web-UI restores still create NO row (design amendment 2026-08-02 — enforced by `restoreVersion`'s existing `agentName` gate, untouched). |

### `document_versions` (named version)
Untouched columns. Derived display fields change: `authors`/`timestamp` now
computed from `yjs_updates` rows in `[clock_start, clock_end]` (FR-001/003),
never from a containing auto-version.

### Chat message tool part (chat store JSON)
| Field | Role |
|---|---|
| `toolCallId`, `type` (`tool-*`) | Card identity for the stamp path (existing). |
| `output.editRange` (`{clockStart, clockEnd}`) | The card's recorded range (feature 016 contract) — now the evidence compared against the undone/redone record (FR-015). Absent ⇒ mismatch ⇒ skip + log. |
| `reverted` | Stamp — now written ONLY after range verification. |

## In-memory / derived structures

### Range-scoped version meta (NEW, pure function output — R1/R16)
`computeRangeMeta(updates, clockStart, clockEnd)` →
`{ authors: Author[], onBehalfOf: Identity[], onBehalfOfMore: number, timestamp }`
- Inputs: the timeline's meaningful-filtered updates array (ascending clock).
- Rules: rows in `[clockStart, clockEnd]` only; author keying/dedupe identical
  to `groupUpdatesIntoVersions` (agent composite keys, `UNKNOWN_AUTHOR` collapse,
  `dedupeOnBehalfOf` cap); timestamp = last in-range row's `createdAt`.
- Noise-only fallback (R16): if the filtered range is empty but unfiltered rows
  exist in range, recompute from the unfiltered range rows; empty authors only
  for a genuinely row-less range.
- Consumers: named-version objects + BOTH auto-version fragment sites in
  `mergeNamedVersions` (which gains the `updates` parameter).

### Sub-version (drill-down group — FR-004)
`updateCount` semantics change: number of meaningful-surviving rows grouped into
the sub-version (was `clockEnd - clockStart + 1`). Sub-versions grouped from the
filtered set only; timeline totals and drill-down counts agree by construction.

### Undo/redo result (additive fields — FR-015)
`performUndo` success: `+ undoneRecordRange: { clockStart, clockEnd }` (claimed
row's `edit_clock_*`). `performRedo` success: `+ redoneRecordRange` (same
fields — the ORIGINAL edit's range, which is what the card stores). All honest-
empty results unchanged. Consumers: chat undo/redo route (stamp verification);
MCP tool results carry the field harmlessly (additive).

### Panel selection (client hook state — FR-007)
`selection` is now a RECONCILED pointer: after every refresh (CRUD or poll) it
is re-resolved to the fresh list object containing the old `clockEnd`
(RBD-041-8) or the default selection; preview reload only when the resolved
(clockEnd, previousClock) pair changed. New sibling state: `diffError`
(preview-load failures), distinct from `error` (timeline/CRUD failures).

### Drill-down cache ↔ expansion (client — FR-009)
Invariant: an id in `expandedVersions` that exists in the fresh list either has
cached `versionUpdates[id]`, is loading, or triggers a re-fetch; expanded ids
absent from the fresh list are dropped. "No individual updates" renders only
after a successful zero-subversion response.

### Bind-failure state (server — FR-010)
On a real load error: doc marked `_bindFailed`, evicted from the y-websocket
`docs` map, connections closed 1013, `notifyException` paged. No persistent
state; next connection attempt re-creates and re-binds. "No rows" is NOT this
state — it never throws and binds normally.

### Live-doc restore delta (server — FR-011/013)
`peekSharedDoc(docGuid)` (NEW in document-service): `docs.get('s/'+guid) || null`,
never creates. Restore live path: transaction on the peeked doc under
`ORIGIN_RESTORE`, origin-scoped captured bytes = the stored row. Not-loaded
path: existing tempDoc delta. Cross-pod residual documented, not modeled.

## State transitions (unchanged, verified against design ground truth)
- `agent_edits` active⇄undone CAS machine: untouched.
- Human web-UI restore: `yjs_updates` row under the human, NO `agent_edits` row,
  not an undo target (design amendment 2026-08-02 / 040 D19) — this feature adds
  no transition that could re-create one.
