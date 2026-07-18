# Quickstart — validating 019-sync-path-discoverability

Prerequisites: the Minikube app-dev pod (docs/dev.md) or the local backend test
stack (pg + pgvector + redis). Backend tests are Jest and MUST run serially
against the shared test DB.

## Automated validation (the authoritative gate)

```sh
# Recipe tool contract + registry/scopes + alias + budgets + trigger words
npx jest --runInBand \
  server/mcp/__tests__/tools/import-markdown-file.test.js \
  server/mcp/__tests__/tools/tool-modules.test.js \
  server/mcp/__tests__/tools/trigger-surfaces.test.js \
  server/mcp/__tests__/tools/create-document-teaching.test.js \
  server/mcp/__tests__/tools/read-document.test.js \
  server/mcp/__tests__/tools/create-access-token.test.js \
  server/__tests__/token-claim.test.js \
  server/__tests__/markdown-sync.rejection.test.js \
  server/__tests__/agents-md-claims.test.js \
  server/__tests__/chat-tools.test.js

# End-to-end recipe + remedy (live listening server, real bash execution)
npx jest --runInBand __tests__/integration/import-recipe-e2e.test.js \
  __tests__/integration/sync-push.route.test.js

# Full serial backend suite before commit
npm test -- --runInBand
```

Expected: all green; the byte-budget test proves every advertised description
≤ 2,048 UTF-8 bytes (including modify and get_collaborators, over-cap before 019)
and server instructions ≤ 1,536 bytes.

## Manual scenario walkthroughs

### US1 — recipe end-to-end (SC-002)

1. Connect an MCP client with write scopes; `tools/list` → **sixteen** tools,
   `import_markdown_file` present, first description line contains "sync".
2. Call `import_markdown_file()` (no args). Inspect the result: no file content,
   no `sk_sqd_`, one `one_time_use_` secret inside `command`.
3. Copy `command`, set `FILE=` to a real markdown file, run it once. Expect:
   token at `~/.squire/token`, new document with the file's content, the file
   overwritten with a frontmattered receipt (`squire:` block with docGuid+clock).
4. Edit the file, push with
   `curl -X PUT -H "Authorization: Bearer $(cat ~/.squire/token)" -H "Content-Type: text/markdown" --data-binary @file.md "$BASE/api/docs/<docGuid>/import?mode=sync"`
   → 200 receipt (the write-back made a valid baseline).
5. Re-run the original command → fails at the claim step (one-shot), with the
   built-in failure message.

### US2 — surfaces as a client sees them

`tools/list` and `initialize` via curl against `/mcp`: check the pinned words on
create_document (title line, already-read-it sentence, markdown param schema),
modify ("or syncing", mode=sync), get_tool_documentation headline, instructions
phrase "to sync/import an existing file".

### US3 — nudge / refusal

- `create_document({ markdown: <3 KB body> })` → created, result carries the
  `POST /api/docs/import` pointer.
- `create_document({ markdown: <11 KB body> })` → instructive refusal, nothing
  created; retry with `allowRetyped: true` → created, nudge still present.
- Set `CREATE_DOCUMENT_REFUSAL_BYTES=4096`, restart the dev server, verify a 5 KB
  body now refuses; set `CREATE_DOCUMENT_REFUSAL_BYTES=1` (invalid, ≤ nudge) and
  verify defaults apply again.

### US4 — first-sync remedy

`mode=sync` push of a frontmatter-less file → 400 `sync_baseline_missing` whose
message includes "First sync of this file? …". Follow it verbatim; the next sync
push succeeds.

### US5 — agents.md

Fetch `/agents.md`: "Sync a repo file" heading with the four steps; tool list
names `import_markdown_file`; no standalone `read_document_version` entry.

### DR-1 — merge and alias

- `read_document({ docGuid, versionId: "42", format: "markdown" })` returns the
  historical content + `version` metadata; same call without `versionId`
  unchanged.
- `tools/call` with name `read_document_version` still works (hidden alias);
  `tools/list` does not contain it.
- A `documents:write`-only token can call `get_tool_documentation`.
