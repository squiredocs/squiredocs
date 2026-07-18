# Contract — Teaching surfaces: trigger words, byte budgets, nudge/refusal, remedy

## 1. Trigger-word contract (US2 / FR-009..FR-015 / SC-005 — all test-asserted)

| # | Surface | File | Required content |
|---|---------|------|------------------|
| 1 | `create_document` title (first) line | `server/mcp/tools/create-document.js` | names syncing/importing an **existing file** as the case NOT to use this tool for |
| 2 | `create_document` byte-channel redirect | same | the already-read-it sentence: even if the file has already been read, the file remains the source of truth — use the byte channel |
| 3 | `create_document` `markdown` **param schema description** | same (`inputSchema.properties.markdown.description`) | one-sentence redirect away from retyping existing files (schema-skimming clients) |
| 4 | `modify` byte-channel redirect | `server/mcp/tools/modify.js` | covers **"or syncing"** and names **`mode=sync`** |
| 5 | `get_tool_documentation` headline (first line) | `server/mcp/tools/get-tool-documentation.js` | names the REST **byte channel** and the **`rest_api`** tool id alongside the script tools |
| 6 | Server instructions CHANNEL RULE | `server/mcp/index.js` `SERVER_INSTRUCTIONS` | contains the phrase **"to sync/import an existing file"** |
| 7 | `import_markdown_file` first line | `server/mcp/tools/import-markdown-file.js` | contains **"sync"**, names the task |
| 8 | agents.md | `client/public/agents.md` | heading **"Sync a repo file"** with the four recipe steps (see US5) |

Tests use tolerant regexes on the normative words (research R7), except the
design-pinned verbatim strings (#2's clause, the FR-022 remedy sentence).

## 2. Byte budgets (FR-016 / SC-004 / DR-1 item 2 — one shared test)

- Every **advertised** tool description: ≤ 2,048 UTF-8 bytes, asserted with
  `Buffer.byteLength(description, 'utf8')` over `toolRegistry.getToolList()`
  (`server/mcp/__tests__/tools/tool-modules.test.js`, converted from the current
  character-based cap).
- `SERVER_INSTRUCTIONS` (exported from `server/mcp/index.js`): ≤ 1,536 UTF-8
  bytes (RBD-7).
- Budgets re-measure against implement-time `main` (spec Assumptions).
- Known over-cap today (must land under): `modify` 2,049 B; `get_collaborators`
  2,787 B (banner art).

### Funding trims (content that may be cut vs. must be kept)

| Description | Cut | Keep |
|---|---|---|
| `create_document` | WHY INCREMENTAL five bullets → one line (FR-012) | parameter semantics, title precedence, at-least-one-of rule |
| `modify` | NON-NEGOTIABLE RULES block (canonical home: `get_tool_documentation({tool:"modify"})`) (FR-013) | script contract, parameter list, returns summary (tightened, not dropped) |
| `undo` / `redo` | duplicated prose → ~500 B each (DR-1) | every phrase the 016 tests assert: no "cursor"; "restart"; per-identity wording; "preserved/untouched"; "clock" |
| `get_collaborators` | `═══` banner art (3 B/char) | substantive content |
| `read_document`, `list_documents`, others | prose PARAMETERS sections restating schema property descriptions | XPath examples (teaching content with no other home), returns summary |
| `share_document` | — (51 B) | **gains** the owner-only sentence (DR-1) |

## 3. Nudge / soft refusal on `create_document` (US3 / FR-017..FR-021 / SC-006..SC-007)

Thresholds: see data-model.md (env-tunable, byte-metric, fallback-to-defaults).
Behavior matrix (evaluated BEFORE any side effect; a refusal creates nothing):

| `markdown` UTF-8 bytes | `allowRetyped` | Result |
|---|---|---|
| < nudge | any | byte-identical behavior to pre-019 (existing tests pass unmodified) |
| ≥ nudge, < refusal | any | created; SUCCESS result appends pointer to `POST /api/docs/import` described as byte-faithful and receipt-verified |
| ≥ refusal | absent/false | refused (error result, nothing created); text explains BOTH the byte-channel route AND that retrying with `allowRetyped: true` will be honored |
| ≥ refusal | `true` | created; success result still carries the nudge |

- "≥" is at-or-above (boundary bytes trigger — Edge Cases).
- `allowRetyped` joins `create_document`'s input schema (boolean; FR-020) —
  required so schema-validating clients can pass it, and so the registry's
  unknown-param check does not reject it.
- The refusal is NEVER unconditional — `allowRetyped: true` honored for any
  caller, any size (shell-less agents' path).
- Misconfigured env (refusal ≤ nudge, ≤ 0, non-numeric) ⇒ defaults (never
  refuse-everything / never disable teaching).

## 4. First-sync remedy (US4 / FR-022 / SC-008)

`server/api/docs-import.js` `REJECTION_MESSAGES.sync_baseline_missing` gains,
verbatim:

> First sync of this file? Do an initial import with frontmatter=true and write
> the returned markdown receipt back over the file — it is then a valid sync
> baseline.

The other rejection codes (`sync_doc_mismatch`, `sync_baseline_invalid`,
`sync_baseline_unavailable`) are byte-for-byte unchanged. Following the remedy
verbatim must yield an accepted sync push (integration-tested).
