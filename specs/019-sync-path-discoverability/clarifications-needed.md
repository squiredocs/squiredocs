# Clarifications Ledger — 019-sync-path-discoverability

Decisions the design amendments (`design/agent-surface-mcp.md` — **Amendment (Sam,
2026-07-18) — sync-path discoverability (feature 019)**; `design/markdown-import-two-way-sync.md`
— **Amendment (Sam, 2026-07-18) — teaching surfaces for the byte channel (feature 019)**;
both at commit 3b13209) did not answer were taken with the best default and recorded here as
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)** per Constitution Principle VI.

Decisions the amendments already made are Sam-ratified 2026-07-18 and are cited in the spec,
not re-decided: the tool name `import_markdown_file` and its content-free input schema
(at most `{ docGuid?, intent: create|update|sync }`), the one-compound-command output shape
(claim + curl import + receipt write-back) built on the pending-mint machinery, "sync" in the
tool's first description line, tool count seventeen, the full trigger-word contract
(create_document title line + already-read-it sentence + markdown param-schema redirect;
modify "or syncing" + `mode=sync`; get_tool_documentation headline naming the byte channel +
`rest_api`; server-instructions phrase "to sync/import an existing file"; agents.md
"Sync a repo file" heading), the ~2 KB success nudge and ~10 KB soft refusal with the
`allowRetyped: true` escape hatch (never unconditional), the `sync_baseline_missing` remedy
sentence verbatim, and the explicit non-changes (no content-accepting import tool, no
unconditional refusals, no renames; claim delivery, receipt contract, and `rest_api`
reference untouched).

---

## RBD-1: Intent → route mapping and intent defaulting

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment pins `intent: create|update|sync` but not which REST route each
  intent produces, nor what happens when `intent` is omitted (both parameters are optional).
- **Decision**: `create` → `POST /api/docs/import`; `update` → `PUT /api/docs/:docId/import?mode=replace`;
  `sync` → `PUT /api/docs/:docId/import?mode=sync`. Omitted intent defaults to `sync` when
  `docGuid` is present, else `create`. `update`/`sync` without `docGuid` and `create` with
  `docGuid` are instructive parameter errors (spec FR-004, Edge Cases).
- **Why this default**: The tool's framing is "the file is the source of truth", so `update`
  means the file wins wholesale — `mode=replace`, not `append` (append would duplicate the
  document against its own file). Defaulting a bare `docGuid` to `sync` matches the feature's
  name and the highest-intent task ("sync this file"), and a bare call maps to the most common
  first-run case (create a new doc from a file). All three mappings produce a receipt-stamped
  file that is a valid future sync baseline.

## RBD-2: File path enters the command as a placeholder, not a tool parameter

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The compound command must read the file and write the receipt back, so it
  needs the path — but the amendment caps the input schema at `{ docGuid?, intent }`, so the
  tool cannot accept a path parameter.
- **Decision**: The returned command begins with a single shell-variable assignment
  placeholder (e.g. a leading `FILE=path/to/your.md` line the agent edits); every later
  reference (curl `--data-binary`, receipt write-back target) uses that variable. The result's
  message states this is the only edit needed (spec FR-003).
- **Why this default**: One fill-in at the top keeps the "ready-to-run one-shot" promise
  honest (edit one token, run once) while honoring the pinned schema. Server-side path
  knowledge would be meaningless anyway — the path exists only on the agent's machine.

## RBD-3: Threshold values, byte semantics, and env names

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment says "above ~2KB" and "above ~10KB" — a spec needs exact
  numbers, a unit of measure, and the tunability mechanism.
- **Decision**: Trigger metric is the UTF-8 byte length of the `markdown` argument.
  Defaults: nudge at ≥ 2,048 bytes, refusal at ≥ 10,240 bytes; both environment-tunable
  (two env vars with these defaults; exact names are an implementation-plan detail).
  Invalid configurations (refusal ≤ nudge, non-positive, non-numeric) fall back to the
  defaults (spec FR-017, Edge Cases).
- **Why this default**: Bytes, not characters, because the channel rule is about bytes on
  disk and multi-byte text must not dodge the threshold. Powers-of-two match the "~2KB/~10KB"
  language and the 2,048 description-cap convention already in the codebase. Fail-to-defaults
  because a typo'd env var must never turn the soft refusal into refuse-everything (which
  would violate the never-unconditional pin) or disable teaching entirely.

## RBD-4: Description budgets are UTF-8 bytes; modify is over the cap TODAY; both changed descriptions must be trimmed

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The working notes for 019 claimed ~370 of headroom in `modify`'s description
  and comfortable room in `create_document`'s. Measurement of the current source in UTF-8
  **bytes** (the unit clients truncate on; the text contains multi-byte punctuation) gives
  `modify` 2,049/2,048 — already 1 byte over — and `create_document` 1,917/2,048 (131 bytes,
  less than the FR-009/FR-010 additions need). The mandated trigger-word additions cannot
  simply be appended. What governs, and where does the room come from?
- **Decision**: The byte measurements govern; the cap is ≤ 2,048 UTF-8 bytes per description,
  test-asserted in bytes (spec FR-016/SC-004). Both changed descriptions are explicitly
  trimmed to fund their additions (spec FR-012/FR-013): `modify`'s NON-NEGOTIABLE RULES block
  is the trimming candidate (it duplicates content whose canonical home is
  `get_tool_documentation({ tool: "modify" })`); `create_document`'s five-bullet
  WHY INCREMENTAL rationale collapses to one line. Contract content (script contract,
  parameter semantics, returns, title precedence, at-least-one-of rule) is tightened, never
  dropped. Budgets are re-measured against `main` at implement time (a parallel
  surface-reduction effort's description diets may land first — see spec Assumptions).
- **Why this default**: The cap reflects real client truncation, so exceeding it silently
  destroys the tail of the description — `modify` is presumably already losing its final
  characters in strict clients, which makes the trim a latent-bug fix, not a compromise.
  Bytes not characters because truncation operates on encoded length. Trimming duplicated
  teaching prose is safe because the full references live in get_tool_documentation by
  design; that is precisely why the summaries exist.
- **As-implemented (2026-07-19, UTF-8 bytes, test-asserted over the live registry)**:
  `create_document` 1,982; `modify` 1,830 (was 2,049 — over the cap); server
  instructions 1,225 (cap 1,536). Both trims landed as planned (modify's
  NON-NEGOTIABLE RULES block moved to get_tool_documentation with a one-line
  XPath/incremental pointer kept; create_document's WHY INCREMENTAL collapsed
  to one line).

## RBD-5: Shell-less guidance content in the recipe tool's result

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment acknowledges shell-less agents have no byte channel, but does
  not say what `import_markdown_file` should tell one (the tool cannot detect shell-lessness;
  the recipe it returns is useless to such a caller).
- **Decision**: Every result carries a short guidance field for agents that cannot run shell
  commands: if they can make HTTP requests directly, use `create_access_token({ inline: true })`
  and the `rest_api` reference; otherwise use the in-context `create_document`/`modify` path
  (with `allowRetyped: true` above the refusal threshold). Informational only — no behavioral
  branching on client identity (spec FR-007).
- **Why this default**: Mirrors the existing pattern in create_access_token's result
  ("No shell? Re-run with inline: true.") — the accommodation is a signpost in the result,
  which is the only channel the server has. Leaving it out would strand exactly the agents
  the never-hard-blocked pin protects.

## RBD-6: Mint parameters for the recipe's token

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The recipe creates a pending mint; the amendment does not pin the minted
  token's scopes or TTL.
- **Decision**: Scopes `["documents:read", "documents:write"]` (write for the import, read so
  the same token covers a follow-up export/pull); TTL the existing minted-token default
  (1 hour); claim window the existing 300 seconds. The tool itself requires `documents:write`
  in the registry scope map so a read-only principal fails at the tool call, not minutes
  later at claim time (spec FR-001, FR-005, Edge Cases).
- **Why this default**: Reuses every existing bound of the mint machinery unchanged — the
  amendment's "built on the existing pending-mint machinery" is read as "no new knobs".
  Fail-early on scope preserves the recipe's one-shot promise: a recipe that cannot possibly
  work must never be issued.

## DR-1: Surface-area reduction folded into 019 (supersedes FR-024's no-consolidation clause and SC-001's "seventeen")

- **Status**: DESIGN-RATIFIED (Sam, 2026-07-18) — recorded at plan time
- **Source**: `design/agent-surface-mcp.md`, **Amendment (Sam, 2026-07-18) —
  surface-area reduction folded into 019** (commit c790282), which postdates the
  spec draft. Design wins (Constitution VI); the plan folds it in as requirements
  rather than re-opening the spec.
- **Decision**: Three reductions land WITH 019 so the surface changes once:
  1. **read_document absorbs read_document_version**: `read_document` gains an
     optional `versionId` parameter with identical xpath/format semantics;
     `read_document_version` leaves `getToolList()` but remains accepted by the
     execute path as a hidden deprecation alias for a transition window. The
     advertised tool count after 019's `import_markdown_file` addition is
     therefore **SIXTEEN**, not seventeen — SC-001 and FR-001's "seventeenth
     tool" language are superseded on the count (the tool itself still lands).
     Chat surfaces follow: chat.js VERSION workflow, chat-tools XPATH_TOOLS,
     chat-staleness (a versionId read is NOT a snapshot of current content),
     chat-dedup keys, agents.md, README.
  2. **Description diet**: prose PARAMETERS sections restating schema property
     descriptions deleted, banner art removed (fixes get_collaborators' measured
     2,787-byte overrun), undo/redo deduplicated to ~500 bytes each preserving
     every 016-asserted phrase; every advertised description gets a shared
     test-asserted ≤ 2,048-UTF-8-byte budget. share_document gains the
     owner-only sentence.
  3. **get_tool_documentation drops its documents:read scope requirement**
     (static text; a write-only token must be able to read the docs it needs).
- **Explicitly deferred** (pending prod telemetry on mcp.tool.execute spans):
  cutting set_document_version_name; chat/MCP exposure partitioning.
  **Explicitly rejected**: versions mega-tool; undo/redo merge.
- **FR-024's remaining content still holds**: no content-accepting import tool,
  no renames beyond this ratified merge, claim delivery / receipt contract /
  `rest_api` reference untouched.
- **Sub-decisions taken with best defaults under this entry**: parameter name
  `versionId` (matches the absorbed tool); alias mechanism is a registry-level
  hidden map (no handler fork); historical reads skip presence/highlights (a
  version read must not move the live cursor); dedup/staleness semantics mirror
  today's read_document_version rules (plan research R5).
- **As-implemented diet results (2026-07-19, UTF-8 bytes over the live
  registry — all ≤ 2,048, test-asserted)**: get_collaborators 506 (was 2,787
  — banner art removed, latent truncation bug fixed); undo 634 / redo 688
  (were 1,767/1,727; every 016-asserted phrase preserved); read_document 868
  (was 1,194; gained versionId); list_documents 1,135 (was 1,988);
  share_document 129 (was 51; gained the owner-only sentence);
  import_markdown_file 988 (new); hidden read_document_version alias 337.
  Advertised count: SIXTEEN.

## RBD-7: Server-instructions size target

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The instructions must stay "comfortably under client caps" after gaining the
  trigger phrase; "comfortably" needs a number.
- **Decision**: ≤ 1,536 UTF-8 bytes (75% of the 2,048 truncation cap), test-asserted
  alongside the description caps (spec FR-015, SC-004). Measured current size 1,128 bytes;
  the phrase "to sync/import an existing file" adds ~30 bytes.
- **Why this default**: ~500 bytes of reserve means the next two or three small
  amendments also land without a rewrite, while the assertion still fails long before real
  truncation. A bare ≤ 2,048 would let the buffer erode to zero silently.
