# Contract — mint-time token naming (FR-017 / FR-017a)

This is the one **externally visible** contract change in the feature: the MCP tool surface. Design
ground truth: `design/agent-surface-mcp.md`, Amendment 2026-07-30 as corrected by Sam 2026-07-31 —
"the name describes the agent, not the operation".

Rationale for the change: since 037 the token's display name is a **user-facing presence label** — it
is what a watching human sees on the cursor while the agent imports, and what version history records
as the author. It must answer *"who is here"*, not *"what operation ran"*.

---

## 1. `deriveMintedTokenName(agentToken)` — new shared helper

Location: `server/mcp/auth/token-naming.js`. Single rule, shared by both minting tools so they cannot
drift.

```js
deriveMintedTokenName(agentToken) → string   // 1..255 chars
```

| Step | Rule |
|---|---|
| 1 | `agentToken.agentName`, trimmed — if non-empty, use it |
| 2 | otherwise `'AI Agent'` |
| 3 | truncate to 255 |

For a delegation principal, `agentName` is the OAuth-registered `client_name`
(`server/mcp/auth/oauth-flow.js:692`) — i.e. `"Claude Code"`. That is exactly "the connecting client's
identity" FR-017 names; **no new plumbing is required to obtain it**. For an `sk_sqd_` principal
minting a child token, it is the parent token's own name, so the convention propagates instead of
being re-derived.

`agentToken.agentId` is **never** used as a fallback: `api-token:<id>` is an opaque identifier, and
surfacing it as a cursor label would be worse than the generic `'AI Agent'`.

## 2. `create_access_token` — new optional `name` parameter

**Finding that motivates this**: the tool has **no** name parameter today (inputSchema
`server/mcp/tools/create-access-token.js:47-68` = `scopes`, `ttlSeconds`, `inline`). FR-017's "caller
-supplied names remain honored" and FR-017a's "tell agents to name the token after themselves" are both
unimplementable without it. Recorded as ledger **RBD-10**.

```jsonc
{
  "name": {
    "type": "string",
    "description": "Display name for the token — name it after YOURSELF, the agent (e.g. \"Claude Code\"). This name is shown to people watching the document as your live presence label while you import, and recorded as the author in version history. Not an operation name. Defaults to your own agent name."
  }
}
```

| Case | Resulting `api_tokens.name` |
|---|---|
| `name` supplied, valid | the caller's string, verbatim (trimmed) |
| `name` omitted | `deriveMintedTokenName(agentToken)` |
| `name` present but not a string, empty after trim, or > 255 chars | invalid-parameter error, in the tool's existing in-handler validation style (`resolveScopes` / `resolveTtlSeconds` pattern) |

Both delivery modes use the same resolved name: the claim path
(`prepareClaimDelivery(..., { name })` → `pendingMints.createPendingMint`) and the `inline: true` path
(`apiTokens.createToken(userId, tokenName, …)`). No other mint-eligibility, scope-capping, provenance
(`minted_by_*`), or TTL behavior changes.

## 3. `import_markdown_file` — default name only

Line `server/mcp/tools/import-markdown-file.js:176-177`:

| Before | After |
|---|---|
| `` `Minted by ${agentToken.agentName \|\| agentToken.agentId \|\| 'agent'} via import_markdown_file`.slice(0,255) `` | `deriveMintedTokenName(agentToken)` |

The recipe tool takes no content and no name; **no** caller-supplied name parameter is added there
(it returns a ready-to-run command, and a name argument would be one more thing for the agent to get
wrong). Everything else about the recipe — scopes cap, claim delivery, command text, messages — is
unchanged.

## 4. Contract text (FR-017a)

Both tool `description`s gain one sentence stating that the token name is the agent's public identity —
shown as the live presence label while it works in a document and as the version-history author — and
instructing the agent to name the token after itself, never after the operation. Keep it to one
sentence per tool: these descriptions are in every agent's context window on every connection.

## 5. Not in scope

- **No retroactive renaming.** Existing `api_tokens` rows keep their names (FR-017, US5 scenario 3).
  No backfill, **no migration**.
- No change to the Settings → API Tokens UI, to token creation by humans, or to the admin surface.
- No change to scopes, TTLs, caps (`MAX_TOKENS_PER_USER`, `MAX_MINTED_PER_MINTER`), claim mechanics, or
  provenance columns.

## 6. Assertions

| # | Assertion | Requirement |
|---|---|---|
| N1 | `import_markdown_file` from a client registered as "Claude Code" ⇒ token name `"Claude Code"` | FR-017, SC-007 |
| N2 | `create_access_token()` with no `name` ⇒ `deriveMintedTokenName` result; no `"Minted by … via …"` string | FR-017, SC-007 |
| N3 | `create_access_token({ name: "Repo CI" })` ⇒ name stored verbatim, both delivery modes | FR-017, US5 scenario 2 |
| N4 | `create_access_token({ name: "" })` / non-string / > 255 ⇒ invalid-parameter error, no token minted | validation |
| N5 | Principal with no `agentName` ⇒ `"AI Agent"`, never `"api-token:<id>"` | FR-017 |
| N6 | Pre-existing tokens are unchanged after the feature ships | US5 scenario 3 |
| N7 | Both tool descriptions instruct naming-after-self | FR-017a |
