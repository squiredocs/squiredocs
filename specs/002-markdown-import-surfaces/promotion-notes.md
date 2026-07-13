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

### 4. Frontmatter convergence with 003's shared module (post-merge) — CLOSED

- **Context**: this branch was cut before feature 003 merged, so it ships its
  own defensive `squire:` consumer at `server/markdown-import-frontmatter.js`
  (per T003 / decision S1: "frontmatter handling in its own module"). Feature
  003 has since merged a `shared/markdown/frontmatter.js` module that owns the
  `squire:` frontmatter contract (spec §Depends on / FR-006).
- **Convergence opportunity (maintainer, post-merge)**: fold this feature's
  consumer onto `shared/markdown/frontmatter.js` (imported from that module
  directly — 003's review notes it is NOT re-exported from the parser index)
  so there is one frontmatter implementation. Deferred, not done here: the
  shared module does not exist in this worktree, so switching would be
  untested against code this branch cannot see.
- **Safety already satisfied** (per 003's post-merge advisory): this feature
  does NOT re-emit frontmatter via `buildFrontmatter` (residue is preserved as
  a raw-string passthrough into a fenced `yaml` code block, so the
  conservative-fallback "squire lines leak into foreignRaw" issue cannot arise
  here), and it uses NO YAML library — the consumer is a minimal structural
  scan, so js-yaml alias amplification is not reachable and no parsed YAML is
  ever deep-walked / `JSON.stringify`-ed into logs or responses (only the
  scalar `title` string is surfaced). If convergence onto the shared module is
  done later, preserve these two properties (no re-emit round-trip reliance;
  no deep-expand of untrusted parsed YAML).
- **Status: CLOSED (Sam P-3, 2026-07-13 — convergence implemented).** The
  import path now consumes the canonical `shared/markdown/frontmatter.js`
  (js-yaml JSON_SCHEMA, 64 KB pre-parse cap, fail-to-content, foreign-squire
  strip guard) via `importFrontmatter` in `server/markdown-import.js`; the
  line-based `server/markdown-import-frontmatter.js` and its dedicated test
  file are deleted. An additive `scalarTitle(squire)` accessor was added to the
  shared module (title read-out only — no parsing logic forked). The two
  safety properties above are preserved: residue (`foreignRaw`) is still a
  raw-string passthrough into an escape-proof fenced `yaml` code block (no
  `buildFrontmatter` re-emit), and only the scalar title is read from the
  parsed YAML (no deep-expand into logs/responses). Behavior-unique test cases
  (hostile YAML, F2 JSON-escaped titles, residue fencing, cap) migrated to
  `server/__tests__/import-frontmatter.test.js`, which also adds the
  import-vs-sync cross-path agreement corpus (both surfaces now agree on
  squire + stripped body for every fixture, by construction and by test).

## Notes for the merge queue

- **No migration** was added (research R7 — rehosted images reuse
  `document_images`; the import report is transient). If a later change appears
  to need one, escalate to the orchestrator first (tasks.md Migration rule).
- **Sandbox bundle** (`server/mcp/sandbox/isolate-bundle.js`) was regenerated
  (`npm run build:sandbox-bundle`) after adding `fromMarkdown` and is committed.
  It now bundles `prosemirror-model` + `y-prosemirror` (≈1.06 MB → 1.6 MB). On
  a merge conflict, the queue should regenerate it rather than hand-merge.
- **Zero new runtime dependencies** were added.

## Post-merge review findings — latent risks (reviewer, ledgered)

Surfaced during the post-merge adversarial review. None block; each is a
latent scaling/robustness item to promote if the surface grows.

- **Aggregate image-pass deadline. CLOSED (Sam P-1, 2026-07-13 — budget +
  concurrency implemented).** Previously the external image pass fetched images
  serially, each under its own ~10s per-image timeout, giving a serial worst
  case around 20×10s ≈ 200s with no *aggregate* bound. Now the pass runs the
  unique fetches with **bounded concurrency = 4** and under a default **30s
  aggregate wall-clock budget** (`IMPORT_IMAGE_PASS_BUDGET_MS` / `budgetMs`
  option). On budget expiry, in-flight fetches are aborted (shared
  `AbortSignal` composed with the per-fetch timeout) and remaining images
  degrade to plain links with the distinct report reason
  `time-budget-exhausted`. The per-fetch SSRF validation/pinning is per-call
  with no cross-fetch shared mutable state, so it holds under concurrency
  (covered by the concurrency SSRF test). Contract
  (`contracts/image-rehost.md`) §5/§8 updated to normative.

- **Stored-image orphan rows on a late `insertAfterXPath` abort (latent).**
  The staged image pass rehosts/copies images into `document_images` (real
  rows + stored bytes) BEFORE the single live transaction. For
  `insertAfterXPath`, the XPath is re-resolved inside that transaction and can
  still abort (e.g. the anchor was concurrently deleted) — after the image rows
  were already written. Those rows are then orphaned (referenced by no live
  node). Harmless (unreferenced, access-checked) but real storage litter. A
  future cleanup would either move image staging strictly after the anchor is
  pinned, or sweep unreferenced `document_images` rows.

- **Rehost micro-transactions are unattributed.** The image rehost/copy writes
  land as their own storage-layer operations, distinct from the single
  attributed `updateDocument` import transaction. They carry no actor
  attribution of their own (attribution lives on the content transaction). Fine
  today — the import itself is attributed and the image rows are content-linked
  — but if per-asset provenance/audit is ever required, the rehost writes would
  need to carry the acting user/agent.
