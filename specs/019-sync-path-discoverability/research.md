# Research — 019-sync-path-discoverability

**Date**: 2026-07-18 · **Inputs**: spec.md, clarifications-needed.md (RBD-1..7, DR-1),
design/agent-surface-mcp.md (amendments at 3b13209 and c790282),
design/markdown-import-two-way-sync.md (amendment at 3b13209).

All decisions below were resolved by reading the live code on `main` (measurements
taken 2026-07-18). No NEEDS CLARIFICATION items remain.

---

## R1: How the recipe reuses the pending-mint machinery (do not fork)

**Decision**: Extract the mint-preparation logic of `create_access_token` into a
shared function and call it from both tools; `import_markdown_file` never talks to
Redis or the token tables itself.

**Trace of the existing flow** (`server/mcp/tools/create-access-token.js`):

1. `resolveScopes(requested, agentToken.scopes)` — subset-of-caller enforcement.
2. No-chaining guard: if `agentToken.apiTokenId` resolves to a token with
   `minted_by_delegation_id | minted_by_api_token_id`, refuse (lines 121-128).
3. Delegation liveness re-check: `delegation.checkDelegation(delegationId)` — a
   revoked delegation must not mint during its JWT's residual lifetime (lines 134-139).
4. `pendingMints.createPendingMint({ userId, name, scopes, ttlSeconds,
   mintedByDelegationId, mintedByApiTokenId })` (`server/mcp/auth/pending-mints.js`)
   stores params in Redis under SHA-256 of a fresh `one_time_use_` secret,
   `EX 300 NX`, and returns the secret — the only plaintext copy.
5. The result's `claimCommand` embeds the secret in a
   `curl -H "Authorization: Bearer <secret>" $BASE/api/tokens/claim -o ~/.squire/token`
   line; `server/api/token-claim.js` redeems it via the atomic GET+DEL Lua script
   (`redeemPendingMint`) and mints the real `sk_sqd_` token at claim time.

**How 019 reuses it**: refactor steps 2–4 into an exported helper
`prepareClaimDelivery(agentToken, { scopes, ttlSeconds, name })` in
`create-access-token.js` (kept there so its unit tests keep guarding it), returning
`{ claimSecret, claimUrl, claimExpiresInSeconds }`. `import_markdown_file` calls it
with scopes `["documents:read", "documents:write"]` (RBD-6), default TTL
(`apiTokens.MINTED_TOKEN_DEFAULT_TTL_SECONDS`, 1 h) and a name like
`"Minted by <agent> via import_markdown_file"`. The claim endpoint, Redis record
shape, TTLs, hash-at-rest, and one-shot redemption are untouched (FR-005, SC-009).

**Alternatives considered**: (a) duplicating the guard code in the new tool —
rejected: the no-chain and delegation-liveness guards would inevitably drift
(exactly the "fork" the task forbids); (b) moving guards into `pending-mints.js` —
rejected: pending-mints is deliberately a dumb Redis store; the guards are
tool-boundary policy.

## R2: Shape of the one compound command (claim + import + receipt write-back)

**Decision**: The command is a single multi-line shell block, newline-joined, run in
one invocation. Structure (create intent shown; `$BASE` is `agentToken.baseUrl`):

```sh
FILE=path/to/your.md   # ← the ONLY edit: set your markdown file's path
set -e; umask 077; mkdir -p ~/.squire
curl -sf -H "Authorization: Bearer one_time_use_…" "$BASE/api/tokens/claim" \
  -o ~/.squire/token || { echo "claim failed: already claimed or expired (5 min) — call import_markdown_file again for a fresh recipe"; exit 1; }
RESP=$(mktemp)
curl -sf -X POST -H "Authorization: Bearer $(cat ~/.squire/token)" \
  -H "Content-Type: text/markdown" --data-binary @"$FILE" \
  "$BASE/api/docs/import?frontmatter=true" -o "$RESP" \
  || { echo "import failed:"; cat "$RESP"; rm -f "$RESP"; exit 1; }
DOC=$(grep -o '"docId":"[^"]*"' "$RESP" | head -1 | cut -d'"' -f4); rm -f "$RESP"
curl -sf -H "Authorization: Bearer $(cat ~/.squire/token)" \
  "$BASE/api/docs/$DOC/export?format=markdown&frontmatter=true" -o "$FILE"
echo "Imported $FILE → document $DOC. Receipt written back; the file is now a valid mode=sync baseline."
```

For `update`/`sync` intents the `docGuid` is already known, so `$DOC` is inlined and
the middle call is `PUT $BASE/api/docs/<docGuid>/import?mode=replace|sync&frontmatter=true`.

**Receipt write-back mechanics**: the import routes return JSON
(`docs-import.js:322` — `{ docId, title, url, clock, blocks, images, markdown }`),
and safely extracting an arbitrary markdown string from JSON in portable shell is
not possible (escape sequences). Two extraction problems arise:

- **docId** (create intent only): safe with `grep -o '"docId":"[^"]*"'` — UUIDs
  draw from `[0-9a-f-]`, which never needs JSON escaping.
- **the receipt markdown**: NOT extracted from JSON. The write-back is a follow-up
  `GET /api/docs/$DOC/export?format=markdown&frontmatter=true` — raw markdown on
  the wire, `-o "$FILE"`. By the receipt contract the receipt *is* the canonical
  re-export at the post-import clock, so the exported bytes equal the receipt
  unless a concurrent edit landed in the sub-second window; even then the file is
  export-at-clock-N stamped with clock N — a valid `mode=sync` baseline by
  construction. Fidelity verification (byte-compare) is done by the SC-002
  integration test against the JSON `markdown` field, not by the shell recipe.

**Token residue**: the token goes server → `~/.squire/token` (the existing
convention, FR-005) and is only ever referenced as `$(cat ~/.squire/token)`; the
command never echoes it. The claim secret appears once in the command — existing,
accepted transcript residue (same as `create_access_token`).

**Alternatives considered**: (a) `node -e`/`python3 -c`/`jq` JSON extraction —
rejected: not guaranteed on the agent host; the recipe must be POSIX-shell + curl
only; (b) adding a raw-receipt response mode (`Accept: text/markdown` or
`?receipt=raw`) to the import routes — rejected: FR-024 pins the receipt contract
and `rest_api` reference as-is; (c) file path as a tool parameter — rejected by
design (RBD-2, pinned schema).

## R3: Teaching thresholds — env names, parsing, evaluation point

**Decision**: Two env vars, `CREATE_DOCUMENT_NUDGE_BYTES` (default 2,048) and
`CREATE_DOCUMENT_REFUSAL_BYTES` (default 10,240), matching the repo's unprefixed
env style (`CHAT_BODY_LIMIT`, `IMPORT_IMAGE_PASS_BUDGET_MS`). A small resolver
(`resolveTeachingThresholds()` local to `server/mcp/tools/create-document.js`)
reads `process.env` **at call time** (testable without module-cache gymnastics),
parses with `Number()`, and falls back to BOTH defaults when the configured pair is
invalid: non-numeric, non-integer, ≤ 0, or refusal ≤ nudge (RBD-3, FR-017).
Trigger metric: `Buffer.byteLength(markdown, 'utf8')`. Evaluation happens before
any side effect (`createSeededDocument` is only reached on the success paths), so a
refusal creates nothing (Edge Cases).

**Alternatives considered**: config module read at boot — rejected: per-call read
is what makes SC-006's env-tunable tests trivial and honest; the cost is two env
reads per create call, negligible.

## R4: Byte-budget test strategy (SC-004) and the character-count latent bug

**Decision**: Convert the existing cap test in
`server/mcp/__tests__/tools/tool-modules.test.js` (line 131: `MAX_DESCRIPTION_CHARS
= 2048` compared against `description.length`) to
`Buffer.byteLength(description, 'utf8') <= 2048`, applied over the live registry
(`toolRegistry.getToolList()`) so every advertised tool — including new ones — is
covered by construction. Export `SERVER_INSTRUCTIONS` from `server/mcp/index.js`
(currently a module-private const at line 171) and assert
`byteLength ≤ 1536` (RBD-7) in the same suite. The tests `require` the live tool
modules — budgets automatically re-measure against implement-time `main`
(spec Assumptions).

**Measured baseline (2026-07-18, UTF-8 bytes / chars)** — confirms the spec's
numbers and surfaces one the spec missed:

| Surface | Bytes | Chars | Status |
|---|---|---|---|
| create_document | 1,917 | 1,903 | 131 headroom — insufficient for FR-009/010 |
| modify | 2,049 | 2,041 | **over the byte cap today** (char test masks it) |
| get_tool_documentation | 922 | 920 | ample |
| create_access_token | 1,225 | 1,217 | unchanged by 019 |
| read_document | 1,194 | 1,194 | gains versionId; PARAMETERS prose deletable |
| read_document_version | 962 | 962 | becomes hidden alias |
| undo / redo | 1,767 / 1,727 | 1,463 / 1,423 | diet target ~500 bytes each (DR-1) |
| **get_collaborators** | **2,787** | 1,587 | **over the byte cap today** — box-drawing banner art is 3 bytes/char; the char test hides a 739-byte overrun |
| share_document | 51 | 51 | gains owner-only sentence (DR-1) |
| list_documents | 1,988 | 1,984 | near cap; PARAMETERS prose deletable |
| server instructions | 1,128 | — | target ≤ 1,536 |

The `get_collaborators` overrun is a second latent truncation bug of exactly the
kind RBD-4 describes for `modify`; the DR-1 banner-art removal fixes it.

## R5: read_document absorbs read_document_version (DR-1 fold-in)

**Decision** (mechanics for design amendment c790282 item 1):

- `server/mcp/tools/read-document.js` gains optional `versionId` (string; UUID or
  clock-number string) in its input schema. Handler branches: with `versionId`, run
  the historical path (access check via `documents.hasAccess`, no presence session,
  no highlights — historical reads must not move the live cursor), reconstruct the
  version Y.Doc, `queryAndSerialize` with identical xpath/format semantics, return
  the version result shape (`content, blockCount, characterCount, matchCount?,
  version` metadata). Without `versionId`: today's behavior, byte-identical.
- The historical core moves from `read-document-version.js` into a shared function
  in `server/mcp/tools/read-helpers.js` (already the shared home for
  `queryAndSerialize`); `read-document-version.js` becomes a thin delegate to it,
  keeping its own name/schema.
- `server/mcp/tools/index.js`: `read_document_version` is removed from the
  advertised `tools` map (so `getToolList()` omits it) and moved to a
  `HIDDEN_TOOL_ALIASES` map consulted by `getTool()` — `executeTool` therefore
  still accepts it (deprecation alias, transition window). `TOOL_SCOPES` keeps its
  `read_document_version: 'documents:read'` entry.
- Advertised count after 019: **sixteen** (15 − read_document_version’s slot
  + import_markdown_file). SC-001's "seventeen" is superseded by DR-1.
- Chat surfaces: `server/api/chat.js` VERSION workflow prompt (line ~160) says
  "read_document with versionId"; `chat-tools.js` `XPATH_TOOLS` drops
  `read_document_version` (paging guidance keys off read_document);
  `chat-staleness.js` `SNAPSHOT_TOOLS` handling must NOT treat a
  `read_document({ versionId })` call as a fresh snapshot of current content
  (historical content must not clear staleness) — the snapshot-recording sites
  gain a `!input.versionId` guard; `chat-dedup.js` supersede/dedup keys treat
  `read_document` calls with `versionId` like today's `read_document_version`
  (per `(docGuid, versionId, xpath, format)`) and never let a versioned read
  supersede a current read or vice versa.

**Alternatives considered**: deleting `read_document_version` outright — rejected
by design (transition window for connected clients mid-conversation); a versions
mega-tool and undo/redo merge — explicitly rejected in the amendment.

## R6: End-to-end recipe test bootstrap (SC-002)

**Decision**: New `__tests__/integration/import-recipe-e2e.test.js`, bootstrapped
like `__tests__/integration/docs-import-api.test.js` (real `requireAuth`, real
persistence via `server/__tests__/helpers/db`, y-websocket `setPersistence`
binding, real import router) **plus**: mount `server/api/token-claim.js`, and
`app.listen(0)` on an ephemeral port — the recipe is a real shell command and needs
a live HTTP origin (supertest's in-process transport cannot serve `curl`). The test:

1. Calls the tool handler directly with `agentToken.baseUrl = http://127.0.0.1:<port>`.
2. Asserts the result carries no `sk_sqd_` and no file content (SC-003).
3. Substitutes the `FILE=` placeholder, runs the command via
   `child_process.execFile('bash', ['-c', cmd], { env: { ...process.env, HOME: tmpHome } })`
   with `HOME` pointed at a temp dir so `~/.squire/token` is sandboxed.
4. Verifies: document exists with the file's content; JSON receipt (fetched
   in-test) byte-equals the canonical export; the written-back file has `squire:`
   frontmatter; a follow-up `mode=sync` push of an edited copy succeeds (US1
   scenario 3); running the command a second time fails at the claim step
   (one-shot).

Backend tests run serially against the shared DB (Constitution II); the suite
joins the Jest integration project.

## R7: Trigger-surface tests (SC-005)

**Decision**: One new suite `server/mcp/__tests__/tools/trigger-surfaces.test.js`
asserting, against the live modules: the pinned words on each surface
(create_document title line exclusion; already-read-it sentence; `markdown`
param-schema redirect; modify "or syncing" + `mode=sync`; get_tool_documentation
headline naming the byte channel + `rest_api`; server-instructions phrase
"to sync/import an existing file"; import_markdown_file first line contains
"sync"). String assertions are tolerant regexes on normative words, not full
sentences (same lesson as agents-md-claims.test.js finding C8), except the two
design-pinned verbatim sentences (already-read-it clause per FR-010's normative
phrasing and the FR-022 remedy text, which lives in the US4 tests).

## R8: agents.md update + drift guard

**Decision**: Extend `server/__tests__/agents-md-claims.test.js` (the established
drift-guard pattern) with: "Sync a repo file" heading present; the four recipe
steps (import_markdown_file or write-scoped mint → initial import with
`frontmatter=true` → receipt write-back → `mode=sync` pushes) present in that
section; `import_markdown_file` listed among tools; no stale standalone
`read_document_version` listing (DR-1). Edit `client/public/agents.md`
(§ "Core tools" list and a new section adjacent to "REST endpoints").

## R9: Description diet plan (DR-1 item 2)

**Decision** (per-tool, informed by R4 measurements): delete prose `PARAMETERS:`
sections that restate input-schema property descriptions (read_document,
read_document_version→helper doc, list_documents, get_tool_documentation keeps its
param note only where it adds non-schema info), remove the `═══` banner art from
get_collaborators (fixes its 2,787-byte overrun), deduplicate undo/redo prose to
~500 bytes each while preserving every phrase the 016 contract tests assert
(`restart`, per-identity wording, `preserved|untouched`, `clock`, no `cursor`),
add the owner-only sentence to share_document. XPATH examples in read_document
stay (they are teaching content that exists nowhere else; the RETURNS summary is
tightened instead). Hard gate: the R4 byte test over the whole registry.

## R10: get_tool_documentation scope drop (DR-1 item 3)

**Decision**: Remove the `get_tool_documentation` entry from `TOOL_SCOPES` in
`server/mcp/tools/index.js` (absent entry ⇒ no scope check in `executeTool`). It
serves static text; a write-only token must be able to read the docs it needs.
Test: `executeTool('get_tool_documentation', …)` succeeds with a principal whose
scopes are `['documents:write']` only.
