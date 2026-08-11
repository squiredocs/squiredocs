# Contract: The whole-file-vs-targeted-edit guidance split

**Feature**: 054-sync-feedback-hardening (US5, FR-015/FR-016)
**Design authority**: `design/agent-surface-mcp.md`, Amendment (2026-08-11).

Guidance only. **No tool behavior changes.** The channel rule itself — bytes that already
exist outside the model are never retyped through model context — is unchanged. This adds a
routing clause *inside* it.

## The ratified sentence

> Whole-file byte-channel sync is for authoring, importing, and bulk updates; XPath-targeted
> modify is for small targeted edits, and is the preferred tool when the document is being
> actively edited or a specific node is damaged.

Surface-appropriate wording is expected; the two halves and the "actively edited or damaged
node" trigger must survive in every variant.

## Approved variants (measured)

| Variant | Bytes | Use where |
|---|---|---|
| **FULL** — "Whole-file byte-channel sync is for authoring, importing, and bulk updates. XPath-targeted modify is for small targeted edits, and is the preferred tool when the document is being actively edited or a specific node is damaged." | 226 | Prose surfaces with no budget: `agents.md`, `README.md`, `export-api.js`, `skill.md`, `onboard.md`, Kiro/Cursor generated text |
| **COMPACT** — " Whole-file sync is for authoring, importing, and bulk updates; for a small targeted edit — especially to a doc someone is actively editing, or a damaged node — prefer modify." | 179 | `SERVER_INSTRUCTIONS` (311 bytes headroom → 132 left) |
| **MICRO** — " Small targeted edit, especially to a doc someone is actively editing or a damaged node? Prefer this tool: whole-file sync is for authoring, importing, and bulk updates." | 169 | `modify.js` description (218 bytes headroom → 49 left) |
| **PLAIN** — "Whole-file sync is for authoring, importing, and bulk updates. For a small targeted edit, especially to a document someone is actively editing or a damaged node, prefer the modify tool." | 185 | `chat.js` system prompt — **no em dashes** (the prompt's own rule at `chat.js:197` forbids them) |

Variants are starting points, not literals to paste blindly. **Re-measure after every edit**;
the byte gates are tests, not guidelines.

## Measured budgets (verified 2026-08-11 on `main`)

| Surface | Current | Cap | Headroom | Pin |
|---|---|---|---|---|
| `SERVER_INSTRUCTIONS` (`server/mcp/index.js:180-198`) | **1,225 B** | 1,536 | **311 B** | `trigger-surfaces.test.js:93-95`; `tool-modules.test.js:165,178-181` |
| `modify.description` (`modify.js:69-104`) | **1,830 B** | 2,048 | **218 B** | `trigger-surfaces.test.js:75-77`; `tool-modules.test.js:137,153-156` |
| `import_markdown_file.description` (`import-markdown-file.js:36-50`) | **1,216 B** | 2,048 | **832 B** | `import-markdown-file.test.js:86-88` |

**`modify.js` is the binding constraint.** Preferred tactic: **rewrite** its existing
sync-redirect paragraph (`modify.js:77-80`) to carry the split rather than appending a
sentence — a near-zero net byte change. Appending MICRO leaves only 49 bytes.

## Phrases that must survive verbatim

These are `toContain` assertions. Breaking one fails a pinned test.

| Literal | Surface | Pin |
|---|---|---|
| `to sync/import an existing file` | `SERVER_INSTRUCTIONS` | `trigger-surfaces.test.js:88-91` (FR-016) |
| `mode=sync` | `modify.description` | `trigger-surfaces.test.js:60-63` |
| `THE CHANNEL RULE` | `rest_api` documentation | `get-tool-documentation.test.js:70-81` |

Also still required by existing regex pins: `modify.description` must match `/or syncing/i`,
`/xpath/i`, `/positional/i` and contain `get_tool_documentation`, and must **not** contain
`NON-NEGOTIABLE RULES`; `import_markdown_file`'s **first line** must contain `sync` and match
`/existing/`; `rest_api` and `export_api` must return byte-identical documentation.

## Write sites — the nine surfaces are **twelve** files

FR-015 lists nine *surfaces*. Three of them are **generated**, and their source is inline text
in `distribution/publish.mjs` — **not** `distribution/shared/`. Editing the checked-in copies
would be silently reverted by the next `node distribution/publish.mjs`.

| # | FR-015 surface | File to actually edit | Note |
|---|---|---|---|
| 1 | MCP server instructions | `server/mcp/index.js:188-198` | COMPACT; keep trigger phrase |
| 2 | `rest_api` docs — channel-rule block | `server/mcp/tools/tool-documentation/export-api.js:18-30` | FULL; keep `THE CHANNEL RULE` |
| 2b | `rest_api` docs — two-way-sync section | `server/mcp/tools/tool-documentation/export-api.js:203-254` | FULL, sync-side framing |
| 3 | `modify` sync-redirect | `server/mcp/tools/modify.js:77-80` | **Rewrite**, don't append |
| 4 | `import_markdown_file` | `server/mcp/tools/import-markdown-file.js:36-50` | Attach to the intent list (:40-43); keep first line contract |
| 5 | Distribution skill source | `distribution/shared/skill.md:22-30` | Source of truth → Claude + Cursor SKILL.md |
| 5b | Distribution onboard source | `distribution/shared/onboard.md:57-59` | Source of truth → `commands/onboard.md` |
| 6 | Kiro steering | **`distribution/publish.mjs:420-422`** | GENERATED — inline source, not `shared/` |
| 6b | Kiro POWER.md | **`distribution/publish.mjs:332`** | GENERATED — inline source |
| 6c | Cursor rule `.mdc` | **`distribution/publish.mjs:499`** | GENERATED — inline source (comment at :502 says so) |
| 7 | Published agent guide | `client/public/agents.md:182-186` (+ sync loop :212-235) | FULL |
| 8 | README sync docs | `README.md:513-523` (+ :694-745 MCP section) | FULL. Constitution I requires it anyway |
| 9 | In-app chat prompt | `server/api/chat.js:173-181` | **Addition, not edit** — see below |

After editing `shared/*` or `publish.mjs`, run `node distribution/publish.mjs` (dry-run by
default: regenerates and validates without network) and commit the regenerated files. The
Cursor generator has a **drift tripwire** (`publish.mjs:539-547`) that throws if the
`/squire:onboard` clause wording in `shared/skill.md` moves — do not disturb that clause.

## Surface 9 is a gap, not an edit

`server/api/chat.js`'s `BASE_SYSTEM_PROMPT` (:131-224) contains **no channel-rule text at
all**. The nearest analogue is the markdown-attachment workflow at :173-176. The byte-channel
mechanics live only in code comments (:581, :980, :1439), never in model-facing text.

So this surface **gains** channel-rule guidance rather than having it amended. Two constraints:

1. Use the **PLAIN** variant — the prompt's own rules forbid em dashes (`chat.js:197`).
2. Keep it proportionate. The in-app chat agent edits documents directly; the split's value
   there is "prefer targeted modify on a live-edited doc", which is the half that applies.

## Verification (SC-007)

1. `npx jest server/mcp/__tests__/tools/` — budgets, trigger phrases, first-line contracts.
2. `node distribution/publish.mjs` — regenerates and validates; no drift-guard throw.
3. Grep every row in the table above for the split's two halves.
