# Data Model — 048-per-identity-server-docs

**No schema change.** Every entity below is either in-memory or an existing
durable row whose SEMANTICS tighten. Field lists name only what this feature
reads or guarantees.

## In-memory entities

### Ephemeral per-operation doc (NEW)
| Aspect | Value |
|---|---|
| Type | `Y.Doc`, default options (gc on — matches the shipped durable-log restore temp doc) |
| Lifetime | one `updateDocument` call (or one `restoreVersion` call); destroyed after its update bytes are captured, before/independent of the merge |
| Identity | `doc.clientID` — random by construction, NEVER pinned, NEVER reused (FR-002). This is the one-shot authorship identity for the operation's durable row |
| Seed | `Y.applyUpdate(eph, Y.encodeStateAsUpdate(source))` where source = the BOUND shared doc (`updateDocument`) or the best trusted state (restore: trusted live doc, else persisted log) |
| Invariants | exactly one transaction runs on it; capture listener attached AFTER the seed; no provider, no awareness, never announces (FR-010) |
| State transitions | created → seeded → transacted (0 or 1 update emitted) → destroyed |

### Shared server doc (`WSSharedDoc`) — semantics tightened
| Aspect | Value |
|---|---|
| After cutover | receives only PRE-ENCODED BYTES: browser frames, Redis relays, db loads, merge-backs (`Y.applyUpdate(sharedDoc, bytes, origin)`), live applies. Its own `clientID` never authors a content operation (the pinned invariant, FR-007) |
| Trust flags (unchanged, 046) | `_bindComplete` — set at the end of `createBindState`'s success path (`server/collab-bind-state.js:309`); `_bindFailed` — set by `refuseBind` |
| Lifecycle states | created (registry, EMPTY, readable) → binding (persisted load in flight) → **bound** (`_bindComplete`) \| **refused** (`_bindFailed`, evicted). Write paths may seed ONLY from **bound** (FR-013, RBD-048-4); read-to-store paths additionally require ≥1 live connection (`isTrustedLiveDoc`, unchanged) |

### Origin object `{ userId, agentName }` — unchanged
Created per call (`createOrigin`); OBJECT IDENTITY scopes the shared-doc
capture; fields stamp the durable row via the bindState persistence listener.
Passed both to the ephemeral transaction (uniformity) and to the merge-back
apply (the one that fires the persisted/broadcast event).

### Bind-readiness gate (NEW, `document-service.waitForDocReady`)
| Input | `ydoc`, `docGuid`, `timeoutMs = 5000` |
|---|---|
| Resolves | when `ydoc._bindComplete === true` (immediately for warm docs) |
| Throws | `BindFailedError(docGuid)` when `_bindFailed`; `Error("Timed out waiting for document <guid> to load")` at the deadline |
| Owner of | the half-loaded question for WRITE paths — replaces `docs-import.js`'s `waitForDocLoaded` state-vector poll; does NOT replace `isTrustedLiveDoc` (read-to-store, distinct question, shared `_bindComplete` substrate) |

## Durable entities (existing tables, no DDL)

### `yjs_updates` row — guarantee tightened (SC-001)
For every row written by a server-side operation after cutover:
- `update_data` payload's insert set (`Y.parseUpdateMeta(...).to`) carries a
  fresh clientID distinct from the shared doc's and from every other
  operation's;
- `user_id`/`agent_name` stamp the acting identity (unchanged mechanics);
- `via_sync` stays unset (these writes are never sync frames);
- the clientID → (user, agent) mapping is one-to-one BY CONSTRUCTION; the
  reverse (many clientIDs per identity) is expected and fine.
Exception (documented, pinned by test): sync-push rows keep the deterministic
`syntheticClientId` (idempotent-retry requirement; collision degrades to an
honest ambiguity refusal).

### Resupply resolver sources (FR-008 — all retained, none correctness-bearing for new rows)
| Source | Post-cutover role |
|---|---|
| Live-peek poisoning (`init({ peekSharedDoc })`) | fail-honest TRIPWIRE (defense in depth; deletion is recorded cleanup, RBD-048-3) |
| Durable `CHAT_AGENT_NAME` stamp poisoning | retained — covers pre-cutover chat rows retroactively AND keeps post-cutover assistant rows honestly refused on resupply (RBD-048-1) |
| 2+ identity ambiguity | retained — general |

## Validation rules (from requirements)
- A throwing `updateFn` leaves the shared doc byte-identical (FR-006/SC-005):
  the ephemeral doc is discarded, nothing merges.
- A no-change `updateFn` produces no update event, no merge, no row (edge
  case, unchanged from today).
- Restore stores exactly one attributed row whose stored bytes are the
  broadcast bytes (FR-004; 041 invariant), in both the loaded and not-loaded
  cases.
