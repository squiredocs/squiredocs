# Promotion Notes — 002-markdown-import-surfaces

<!-- Ledger of decisions that must be promoted (ratified into the design doc /
     constitution / spec amendments) or that flag a Squire-source edit the
     implementer cannot make. Per Principle VI, design/ is generated from
     Squire — never hand-edit design/*; amend the Squire doc, then
     `node design/sync.mjs`. -->

## OWED-AT-MERGE — Squire design-doc amendments

These are edits to the **source Squire doc** behind
`design/markdown-import-two-way-sync.md`, which this implementer cannot make
(design/ is generated, not hand-editable). The maintainer must apply them at
merge and re-sync with `node design/sync.mjs`.

### 1. CN-10 — `documents:write` is not a "new" scope (current-state correction)

- **Where**: design §1.2, the PUT-route description that calls
  `documents:write` "(new; today only `documents:read` exists for export)".
- **Correction**: `documents:write` already exists — it is in `sk_sqd_`
  tokens' `DEFAULT_SCOPES` (`server/mcp/auth/api-tokens.js`) and required by
  every MCP write tool (`server/mcp/tools/index.js`). Moreover its REST
  enforcement for mutating methods **already existed** in `requireAuth`
  (`checkScopes` → `requiredScopeForMethod`, research R6) before this feature.
  The genuinely new enforcement this feature adds is the **editor-role check
  on PUT**, not scope plumbing.
- **Suggested wording**: drop the "(new…)" parenthetical; state that PUT
  enforces the existing `documents:write` scope and additionally requires the
  editor role on the target document.
- **Status**: shipped behavior matches the doc's *intent* (write access is
  scope-gated); only the stale current-state parenthetical needs editing.
  Ledgered, not blocking (clarifications-needed CN-10, RATIFIED-BY-DEFAULT).

### 2. CN-9 — link-href sanitization is a documented gap, import-only for now

- **Where**: design import trust discussion (covers images + HTML passthrough;
  silent on link hrefs).
- **What shipped**: import sanitizes link hrefs to an allowlist
  (`http`/`https`/`mailto`/app-relative; others drop the mark, keep text).
  This protects the **import path only**. There is no global href guardrail in
  the editor, the schema, or modify scripts — a pre-existing gap outside this
  feature's mandate.
- **Amendment proposed (follow-up)**: add a design note that link hrefs are an
  untrusted-content vector, and propose a global href guardrail (editor +
  modify) as a future item. Not built here (blast radius beyond M2).
- **Status**: ledgered (clarifications-needed CN-9, RATIFIED-BY-DEFAULT).

### 3. FR-021 rehost scope — import-only, with a candidate follow-up

- **Where**: design image-policy note ("Import should instead fetch-and-rehost…").
- **What shipped**: fetch-and-rehost applies to import surfaces only (the
  import module and `fromMarkdown`-produced nodes in modify). Directly
  authored external srcs (e.g. an `appendBlocks` image) keep today's strip
  behavior (CN-8).
- **Candidate follow-up amendment** (NOT a code decision): extending rehosting
  to *all* modify output would be simpler to explain and better UX, but widens
  the server-egress surface beyond M2's mandate. Flag for a future design-doc
  decision.
- **Status**: ledgered (clarifications-needed CN-8, RATIFIED-BY-DEFAULT).

## Notes for the merge queue

- **No migration** was added (research R7 — rehosted images reuse
  `document_images`; the import report is transient). If a later change appears
  to need one, escalate to the orchestrator first (tasks.md Migration rule).
- **Sandbox bundle** (`server/mcp/sandbox/isolate-bundle.js`) was regenerated
  (`npm run build:sandbox-bundle`) after adding `fromMarkdown` and is committed.
  It now bundles `prosemirror-model` + `y-prosemirror` (≈1.06 MB → 1.6 MB). On
  a merge conflict, the queue should regenerate it rather than hand-merge.
- **Zero new runtime dependencies** were added.
