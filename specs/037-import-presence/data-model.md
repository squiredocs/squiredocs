# Phase 1 Data Model — 037-import-presence

**No persisted schema changes. No migration.** Every entity below is in-memory and request-scoped, or
an existing column whose *default value* changes. This document defines the shapes the implementation
passes around.

---

## 1. Import presence context (`ImportPresence`)

Request-scoped handle returned by `importPresence.open(...)`. Lives for the duration of one
`PUT /api/docs/:docId/import` request plus the trailing session TTL.

| Field | Type | Notes |
|---|---|---|
| `promise` | `Promise<Session\|null>` | Resolves to the agent-presence session, or `null` if presence was skipped or failed. **Never rejects** (`.catch` attached at creation). |
| `docId` | `string` (uuid) | Target document |
| `mode` | `'append' \| 'replace' \| 'sync'` | Drives identity and changed-range strategy |
| `agentToken` | `SyntheticAgentToken` | See §2 |

**States**: `skipped` (non-agent principal, or create-mode — never constructed) → `pending` →
`attached` (session resolved) | `failed` (resolved `null`, logged). No state transition ever
propagates to the import's control flow.

**Validation / invariants**
- Constructed only when `req.user.isAgent === true` (FR-003) and `mode ∈ {append, replace, sync}`.
- Constructed only after `documents.hasRole(docId, userId, 'editor')` returned true (FR-006, edge case
  "Editor-role check fails").
- No field is caller-controllable from the HTTP request (FR-016) — there is no request parameter that
  reaches any presence field.

---

## 2. Synthetic agent token (`SyntheticAgentToken`)

Produced by `createAgentTokenPair` (`server/mcp/auth/agent-token-factory.js`); the `.token` half is
what `getOrCreateSession` consumes.

| Field | append / replace | sync |
|---|---|---|
| `userId` | `req.user.userId` | `req.user.userId` |
| `agentId` | `req.user.agentId` (`api-token:<id>`) | `'repo-sync'` |
| `agentName` | `req.user.agentName` (token display name) | `SYNC_AGENT_NAME` (`'Repo Sync'`) |
| `scopes` | `req.user.scopes` (pass-through, never widened) | `req.user.scopes` |
| `isAgent` | `true` | `true` |
| `rawToken` | freshly signed agent JWT | freshly signed agent JWT |
| `baseUrl` | request base URL | request base URL |

**Derived**: presence session key `${userId}-${agentId}-${docGuid}` and presence-claim key
`agent-presence:${userId}:${agentId}:${docGuid}` — identical to what an MCP tool call with the same
`sk_sqd_` token produces, which is what makes FR-002's dedup hold across surfaces.

**Lifetime**: the JWT is minted per request and never stored, logged, or returned in any response.

---

## 3. Changed range (`ChangedRange`)

| Field | Type | Notes |
|---|---|---|
| `first` | `number` | First changed top-level block index, post-apply |
| `last` | `number` | Last changed top-level block index, post-apply |

Derivation (all read-only, computed **after** apply against the live shared fragment):

| Mode | Rule | Degenerate case |
|---|---|---|
| append | `first = len - report.blocks.imported`, `last = len - 1` | `imported === 0` cannot occur (empty imports throw `EMPTY_IMPORT` before apply) |
| replace | `first = 0`, `last = len - 1` | `len === 0` ⇒ no range |
| sync | `first = min` / `last = max` of top-level indices touched by the `ORIGIN_SYNC_PUSH` transaction, collected via `fragment.observeDeep` | `noop: true` receipt or no observed change ⇒ no range (FR-012); net-deletion span with zero post-apply width ⇒ no range (ledger RBD-7) |

`ChangedRange` is converted to `{anchor, head}` by
`cursorOps.createBlockRangeSelection(fragment, first, last)`, which returns `null` for any
out-of-bounds or inverted range. **`null` ⇒ no `setTemporarySelection` call** — a missing range is
never fabricated (FR-012, FR-013).

---

## 4. Live-update capture (`LiveUpdateCapture`)

New additive return value of `documentService.updateDocument(docGuid, fn, opts)`.

| Field | Type | Notes |
|---|---|---|
| `update` | `Uint8Array \| null` | The bytes emitted by this transaction's `update` event; `null` when the transaction changed nothing (existing 50 ms no-change path) |
| `hadRedisHandler` | `boolean` | `!!ydoc._redisUpdateHandler` sampled **inside** the update listener, i.e. at emit time — the only correct moment (research R3) |

Threaded out of `importMarkdown` as `report.live` (internal module contract; **not** part of the HTTP
receipt). Every existing caller of `updateDocument` ignores the return value; timing semantics are
unchanged.

---

## 5. Minted token name (existing column, new default)

Column: `api_tokens.name` (`text`, ≤ 255) — **unchanged schema**.

| Source | Before | After |
|---|---|---|
| `import_markdown_file` | `"Minted by Claude via import_markdown_file"` | `deriveMintedTokenName(agentToken)` → e.g. `"Claude Code"` |
| `create_access_token` (no `name` given) | `"Minted by Claude via MCP"` | `deriveMintedTokenName(agentToken)` |
| `create_access_token` (`name` given) | *(no such parameter)* | the caller's string, verbatim |

`deriveMintedTokenName(agentToken)`:
1. `agentToken.agentName` trimmed, if non-empty → use it (for a delegation this is the OAuth-registered
   MCP client name, e.g. `"Claude Code"`);
2. else `'AI Agent'`.
3. Truncate to 255.

`agentToken.agentId` is **never** a fallback (`api-token:<id>` is an identifier, not a name).

Caller-supplied `name` validation: string, trimmed, length 1–255; anything else is an invalid-parameter
error in the tool's existing in-handler validation style. Existing rows are never rewritten (FR-017).

---

## 6. Entity relationships

```text
Import request (agent-authenticated, update mode)
   │
   ├─1:1─ SyntheticAgentToken ──1:1── agent-presence Session ──1:1── presence claim (Redis)
   │                                        │
   │                                        └─0..1─ temporary selection (≈10 s, self-clearing)
   │
   ├─1:1─ ChangedRange (0..1 — absent for no-op / degenerate)
   │
   └─1:1─ LiveUpdateCapture ──0..1── Redis publish (only when hadRedisHandler === false)
```

Cardinality note (FR-002): *many* import requests for the same `(userId, agentId, docGuid)` map to
**one** session — enforced by the existing `sessionsByKey` reuse path and the cluster-wide presence
claim, not by anything this feature adds.
