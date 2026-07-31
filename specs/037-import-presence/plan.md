# Implementation Plan: Imports Announce Presence

**Branch**: `main` (solo trunk workflow — Constitution Principle III; no feature branch) | **Date**: 2026-07-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/037-import-presence/spec.md`

## Summary

The REST byte-channel import (`PUT /api/docs/:docId/import`, modes append/replace/sync) is the last
write surface that mutates a live document without announcing itself. This feature makes every
agent-authenticated update-mode import open the **same** server-side agent-presence session the MCP
tools and chat assistant use — opened right after the auth + editor gates, refreshed at apply, showing
a ~10 s temporary selection over the changed range, then self-expiring — and folds in the
cross-replica content fan-out fix that makes "watch the import happen" true on a multi-replica
deployment.

**Technical approach** (four decisions, detailed in [research.md](./research.md)):

1. **Credential (R2)** — mint a **synthetic agent token pair** per request (`createAgentTokenPair`,
   the chat pattern); never recover the raw bearer. It is the only mechanism that can announce
   append/replace as the *token's* name and sync as `'Repo Sync'`, it keeps the dedup session key
   byte-identical to the MCP path, and it avoids handing a long-lived user secret to an outbound client.
2. **Fan-out (R3)** — `mode=sync` adopts `applyLiveUpdate` unchanged (it already store-then-applies an
   encoded update); append/replace **capture the update inside `updateDocument`'s existing transaction
   listener** (recording `hadRedisHandler` at emit time) and publish it through a new publish-only
   `publishIfUnhandled` helper. No double-apply, no double-publish, no new origin sentinel, no
   single-replica behavior change.
3. **Changed range (R4)** — computed post-apply from the live fragment and turned into positions by
   the verified reads-never-write `createBlockRangeSelection`. append/replace use exact arithmetic
   (`imported` count vs. post-apply length); sync uses an `observeDeep` on the fragment filtered to the
   unambiguous `ORIGIN_SYNC_PUSH` origin, so no receipt or engine contract changes.
4. **~2 s cap (R5)** — the cap bounds only the *pre-apply* race (`Promise.race` against a timer that
   **resolves**), which is what covers `getOrCreateSession`'s own access verification and WS dial.
   Nothing after apply is ever awaited: the selection is chained onto the same promise with
   pre-computed positions, so a late session still shows a correct selection at zero response cost.
   `requiredRole: 'editor'` is still passed — a redundant but principled second gate inside the budget.

A companion contract change renames what newly minted tokens are called: both minting surfaces default
to the **agent's** identity (from the MCP client name, e.g. `"Claude Code"`) instead of
`"Minted by … via …"`, and `create_access_token` gains the `name` parameter its own contract presumes.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server), React 18 client (untouched)

**Primary Dependencies**: Express, Yjs, y-websocket, y-protocols, Redis (pub/sub), PostgreSQL

**Storage**: PostgreSQL (`yjs_updates`, `api_tokens`, `document_shares`) — **no schema change, no migration**

**Testing**: Jest (`server/__tests__/`, `__tests__/integration/`) — backend suites are serial-only against the shared DB (Principle II)

**Target Platform**: Linux server, k3s, production topology of record = 2 replicas

**Project Type**: Web service (server-side only for this feature — the client already renders agent presence unchanged)

**Performance Goals**: Presence adds ≤ ~2 s to an import in the worst case and 0 ms on the post-apply path (SC-004)

**Constraints**: Presence is best-effort and must never fail, block, or change an import's response (FR-008/FR-009); presence code paths must never mutate a document (FR-013, SC-005); no new tunables (ledger RBD-3)

**Scale/Scope**: 7 server files touched + 2 new small modules; no client changes; no new endpoints

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1. Source: `.specify/memory/constitution.md` v1.1.1.*

| Principle | Gate | Verdict |
|---|---|---|
| **I. Documentation Reflects Reality** | Behavior changes (imports announce presence; imports fan out cross-replica; minted token names) ⇒ `README.md` must be updated in the same commit | **PASS with obligation** — a README task is carried in tasks.md naming the exact sections (agent presence / import surface / `create_access_token`). The planning agent does not edit README itself. |
| **II. Test-Backed Changes** | Every behavioral change covered; backend suites serial | **PASS** — R7 maps each behavior to an existing or new suite; no format-registry/serialization change, so the round-trip registry suite is untouched. |
| **III. Trunk-Based Solo Workflow** | No new ceremony; no branch unless earned | **PASS** — work stays on `main`; no new config, no new tunables, no new process. |
| **IV. Collaboration-Safe Document Operations** | Targeted Yjs ops, structural targeting, provenance preserved | **PASS** — this feature adds **no** document mutations at all (presence is awareness-only) and explicitly forbids position math from writing (FR-013). Provenance is *strengthened*: the presence label is derived from the same identity that authors the version-history row (FR-015). Block indices used for the selection are read-only coordinates for a cursor, not element targeting for a mutation. |
| **V. Secure by Default** | Auth/ACL on new surfaces; scoped credentials; trust boundary stated | **PASS** — no new endpoint. The presence dial uses a per-request synthetic agent JWT scoped at or below the caller (never the raw user secret, R2); presence opens only after the route's editor-role gate and `getOrCreateSession` re-verifies document access. Trust boundary of the import surface itself is unchanged. |
| **VI. Design Docs Are Ground Truth** | Amendments encoded, not relitigated; gaps flagged in the ledger | **PASS** — the six ratified bullets are encoded verbatim in the spec; every plan-phase decision is recorded as RATIFIED-BY-DEFAULT in `clarifications-needed.md` (RBD-7…RBD-10 added by this plan). One design/code gap found and flagged (R6: `create_access_token` has no `name` parameter). |

**Complexity Tracking**: not required — no violations.

**Post-Phase-1 re-check**: unchanged. The design adds two small server modules and additive return
values to two existing functions; it introduces no new dependency, no new configuration, no new
database object, and no new client code.

## Project Structure

### Documentation (this feature)

```text
specs/037-import-presence/
├── spec.md                      # input
├── clarifications-needed.md     # decision ledger (RBD-7..RBD-10 appended by this plan)
├── plan.md                      # this file
├── research.md                  # Phase 0
├── data-model.md                # Phase 1
├── quickstart.md                # Phase 1
├── checklists/requirements.md   # done (spec phase)
├── contracts/
│   ├── import-presence.md       # server/import-presence.js module contract
│   ├── live-fanout.md           # updateDocument return + publishIfUnhandled + sync fan-out
│   └── token-naming.md          # create_access_token `name` param + default-name derivation
└── tasks.md                     # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
server/
├── import-presence.js               # NEW — the whole presence orchestration for imports
├── live-apply.js                    # + publishIfUnhandled (publish-only companion to applyLiveUpdate)
├── document-service.js              # updateDocument returns { update, hadRedisHandler } (additive)
├── markdown-import.js               # importMarkdown threads the captured update out as report.live
├── markdown-sync.js                 # applySyncPush: inline apply → applyLiveUpdate; injectable redisPubSub
├── api/
│   └── docs-import.js               # PUT route: open presence, refresh + select at apply, publish fan-out
└── mcp/
    ├── auth/
    │   └── token-naming.js          # NEW — deriveMintedTokenName(agentToken)
    └── tools/
        ├── create-access-token.js   # + optional `name` param; agent-descriptive default; contract text
        └── import-markdown-file.js  # agent-descriptive default name; contract text

server/__tests__/
├── import-presence.test.js          # NEW
├── live-fanout.test.js              # NEW
├── api-docs-import.test.js          # extended
└── markdown-sync.*.test.js          # extended (fan-out)

__tests__/integration/
├── docs-import-api.test.js          # extended (presence end-to-end, best-effort)
├── sync-push.route.test.js          # extended
└── redis-sync.test.js               # extended (cross-instance delivery for all three modes)
```

**Structure Decision**: existing web-service layout, server-side only. Two new modules, both small and
single-purpose: `server/import-presence.js` keeps `docs-import.js` a thin route wrapper (its own module
header commits to that), and `server/mcp/auth/token-naming.js` gives the two minting tools one shared
naming rule instead of duplicating a string template. Everything else is an additive edit to an
existing file.

## Key mechanisms (implementer-facing)

### Presence lifecycle on `PUT /api/docs/:docId/import`

```text
requireAuth → rateLimit → content-type → body parse
  └─ editor-role gate (documents.hasRole)          ← unchanged, authoritative for the import
  └─ mode resolved ∈ {append, replace, sync}       ← unknown mode 400s before any presence
  └─ IF req.user.isAgent === true:
        presence = importPresence.open({ docId, user, mode })   ← never throws; .catch attached
        await Promise.race([presence, timerResolving(2000)])    ← the ONLY awaited presence work
  └─ receipt options / empty body / baseline validation / parse / image pass
  └─ APPLY (importMarkdown | applySyncPush)
  └─ fan-out publish (append/replace: publishIfUnhandled; sync: inside applyLiveUpdate)
  └─ range = per-mode changed range (post-apply, read-only)
  └─ presence.then(s => { refreshTTL(s); if (range) setTemporarySelection(s, range) })  ← NOT awaited
  └─ respond (contract byte-identical to today)
```

`POST /api/docs/import` (create) is untouched (FR-004). Human (browser-session) imports skip presence
entirely (FR-003). A failed import leaves the session to expire on its own (ledger RBD-2).

### Fan-out decision table

| Situation | append / replace | sync |
|---|---|---|
| Handling replica **has** a WS conn for the doc | transaction's own `update` event → attached `_redisUpdateHandler` publishes; `publishIfUnhandled` sees `hadRedisHandler === true` and no-ops | `applyLiveUpdate` applies; H1 guard suppresses the explicit publish; the attached handler publishes (`ORIGIN_SYNC_PUSH` is off the skip-list) |
| Handling replica has **no** WS conn | `hadRedisHandler === false` → explicit `redisPubSub.publishUpdate` | `applyLiveUpdate` applies + publishes explicitly |
| Redis disabled (single replica) | `isEnabled()` false → no publish; unchanged | unchanged |
| Receiving replica | applies with `ORIGIN_REDIS` → on the publish skip-list (no loop) and `parseOrigin → null` (no duplicate row) | same |

### Identity table (FR-015)

| Mode | synthetic `agentId` | synthetic `agentName` | Presence label | Version-history author |
|---|---|---|---|---|
| append / replace | `req.user.agentId` (`api-token:<id>`) | `req.user.agentName` | `"<token name> (<user>)"` | same token name (`actorFrom(user)`) |
| sync | `'repo-sync'` | `SYNC_AGENT_NAME` = `'Repo Sync'` | `"Repo Sync (<user>)"` | `'Repo Sync'` (+ on-behalf-of, unchanged) |

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_ | | |
