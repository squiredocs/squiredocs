# Tasks: Sync-Path Discoverability for External Agents

**Input**: Design documents from `/specs/019-sync-path-discoverability/`
(plan.md, research.md R1–R10, data-model.md, contracts/, quickstart.md,
clarifications-needed.md RBD-1..7 + DR-1)

**Tests**: REQUIRED — the spec's Success Criteria are test-asserted (SC-001..
SC-009) and the constitution mandates test-backed changes. Every story writes its
tests FIRST and watches them fail before implementing. Backend tests run
SERIALLY against the shared DB (`--runInBand`, Constitution II).

**Organization**: By user story (US1–US5 from spec.md) plus **US6** — the DR-1
surface-area reduction folded in by design amendment c790282. **Phase order
deviates from pure priority order in one place** (documented in Dependencies):
US6 runs before US2 because its description diet funds the byte room US2's
trigger words spend, and the shared byte-budget test only goes green once both
land. NO database migrations anywhere. Do not touch specs/016-*, 017-*, 018-*.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

**Purpose**: Make the two shared assertion targets reachable by tests. No
behavior change.

- [X] T001 Export `SERVER_INSTRUCTIONS` from `server/mcp/index.js` (add it to
      `module.exports`; the constant itself is unchanged in this task) so tests
      can measure and assert its content and byte size.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared mint machinery and the registry-wide byte gate that every
later story asserts against.

**⚠️ CRITICAL**: T002 blocks US1; T003 defines the RED gate that US6 + US2 turn
green.

- [X] T002 Extract `prepareClaimDelivery(agentToken, { scopes, ttlSeconds, name })`
      in `server/mcp/tools/create-access-token.js` per research R1: move the
      no-chaining guard, the delegation-liveness re-check, and the
      `pendingMints.createPendingMint(...)` call into the exported helper; the
      existing `handler` calls it. Pure refactor — the full existing suites
      `server/mcp/__tests__/tools/create-access-token.test.js` and
      `server/__tests__/token-claim.test.js` MUST pass unmodified (SC-009 guard).
- [X] T003 Convert the description cap in
      `server/mcp/__tests__/tools/tool-modules.test.js` from characters to UTF-8
      bytes per research R4: assert
      `Buffer.byteLength(tool.description, 'utf8') <= 2048` for every tool in
      `toolRegistry.getToolList()` (registry-driven, so new tools are covered by
      construction — keep the per-module loop too), and add
      `Buffer.byteLength(SERVER_INSTRUCTIONS, 'utf8') <= 1536` (import from
      `server/mcp/index.js`, needs T001). EXPECTED RED until Phase 4/5: `modify`
      (2,049 B) and `get_collaborators` (2,787 B) are over the cap today — this
      is the tests-first gate for the diet, not a defect of this task.

**Checkpoint**: helper extracted, byte gate in place (red on two known tools).

---

## Phase 3: User Story 1 — "Sync this file" finds the byte channel (Priority: P1) 🎯 MVP

**Goal**: The `import_markdown_file` recipe tool: advertised, write-scoped,
no-content, returning one ready-to-run compound command (claim + curl import +
receipt write-back) that leaves the file a valid sync baseline.

**Independent Test**: quickstart.md §US1 — list tools, call with no args, run the
returned command against a live server, verify byte-faithful import + receipt
write-back + subsequent mode=sync push; result payload carries no content/token.

### Tests for User Story 1 (write FIRST, must fail)

- [X] T004 [P] [US1] Contract test
      `server/mcp/__tests__/tools/import-markdown-file.test.js` per
      contracts/import-markdown-file.md: module exports (name/description/
      inputSchema/handler/init); first description line contains "sync" and names
      the task (FR-006); schema is exactly `{ docGuid?, intent? }` with the
      three-value enum and no content/path property (FR-002); intent→route
      matrix incl. both defaulting rules (RBD-1) — assert the resolved REST verb
      + path + `frontmatter=true` appear in `command`; `FILE=` placeholder is the
      first line and message says it is the only edit (RBD-2); parameter errors:
      `update`/`sync` without docGuid, `create` with docGuid, invalid intent via
      registry enum; result-payload security (SC-003): JSON-stringify the full
      result for every intent and assert no `sk_sqd_`, no markdown fixture
      content, exactly one `one_time_use_` occurrence (inside `command`); the
      command never `echo`s the token and only references
      `$(cat ~/.squire/token)` (FR-005); shell-less `guidance` names
      `create_access_token({ inline: true })`, `rest_api`, and the in-context
      path (RBD-5/FR-007); statelessness: a bogus docGuid still returns a recipe
      (FR-008).
- [X] T005 [P] [US1] Registry/scope + claim-security regression tests: in
      `server/mcp/__tests__/tools/import-markdown-file.test.js` (registry
      section) assert `getToolList()` contains `import_markdown_file`,
      `TOOL_SCOPES` gating via `executeTool` — a `['documents:read']`-only
      principal gets the standard insufficient-scope error naming
      `documents:write` (FR-001, US1 scenario 5); a minted-token caller
      (minted_by_* set) is refused (no-chaining at the second call site); a
      revoked delegation cannot obtain a recipe; and extend
      `server/__tests__/token-claim.test.js` with a recipe-created pending mint:
      one-shot redemption (second claim null), 300 s expiry unchanged, minted
      token has scopes `["documents:read","documents:write"]` and default TTL
      (RBD-6, SC-009).

### Implementation for User Story 1

- [X] T006 [US1] Implement `server/mcp/tools/import-markdown-file.js` per
      contracts/import-markdown-file.md and research R2: intent resolution +
      instructive parameter errors; call `prepareClaimDelivery` (T002) with
      scopes `["documents:read","documents:write"]`, default TTL, name
      `Minted by <agent> via import_markdown_file`; build the compound command
      for the resolved route (create: POST + escape-safe UUID grep for `$DOC`;
      update/sync: PUT with inlined docGuid) with claim-failure and
      import-failure branches and the receipt write-back via
      `GET .../export?format=markdown&frontmatter=true -o "$FILE"`; result
      fields `{ command, intent, docGuid?, claimExpiresInSeconds, message,
      guidance }`; description first line contains "sync", ≤ 2,048 UTF-8 bytes.
- [X] T007 [US1] Register the tool in `server/mcp/tools/index.js`: require +
      add `import_markdown_file` to the `tools` map and
      `TOOL_SCOPES.import_markdown_file = 'documents:write'`; update the
      expected-tools list in `server/mcp/__tests__/tools/tool-modules.test.js`
      (temporarily 17 advertised — US6/T010 brings it to 16; if US6 lands first
      in a re-ordering, go straight to 16).
- [X] T008 [US1] End-to-end integration test
      `__tests__/integration/import-recipe-e2e.test.js` per research R6 (SC-002):
      bootstrap like `__tests__/integration/docs-import-api.test.js` + mount
      `server/api/token-claim.js`, `app.listen(0)`; call the tool handler with
      `baseUrl` pointing at the listening port; substitute `FILE=`, run the
      command via `bash -c` with sandboxed `HOME`; assert document content
      byte-matches the source file per the JSON receipt, the written-back file
      gained `squire:` frontmatter, an edited copy then passes `mode=sync` (US1
      scenario 3), a second run of the same command fails at the claim step
      (one-shot), and the `sync` intent variant targets the existing document.

**Checkpoint**: MVP — the recipe path works end-to-end and is independently
demonstrable.

---

## Phase 4: User Story 6 — DR-1 surface-area reduction (Design-ratified fold-in)

**Goal**: read_document absorbs read_document_version (hidden alias; advertised
count 16), registry-wide description diet under the byte gate, share_document
owner-only sentence, get_tool_documentation scope drop. Runs before US2 because
the diet funds US2's byte room (see Dependencies).

**Independent Test**: quickstart.md §DR-1 — versionId reads work identically to
the old tool; alias still executes; tools/list has 16 entries; T003's byte test
goes green except `modify`/`create_document` (finished in US2); write-only token
can read docs.

### Tests for User Story 6 (write FIRST, must fail)

- [X] T009 [P] [US6] Extend `server/mcp/__tests__/tools/read-document.test.js`
      per contracts/read-document-merge.md: `versionId` accepted (UUID and
      clock-number string), historical content returned with `version` metadata
      and identical xpath/format semantics (port the behavioral cases from
      `server/mcp/__tests__/tools/read-document-version.test.js` against the new
      parameter), no-versionId behavior unchanged, no presence/highlight on
      versioned reads; in `server/mcp/__tests__/tools/tool-modules.test.js`
      registry section: advertised list is the FINAL 16 (with
      `import_markdown_file`, without `read_document_version`),
      `getTool('read_document_version')` still returns the module and
      `executeTool('read_document_version', …)` still works (hidden alias);
      `executeTool('get_tool_documentation', …)` succeeds for a
      `['documents:write']`-only principal (scope drop); share_document
      description contains the owner-only sentence.
- [X] T010 [P] [US6] Chat-layer tests in
      `server/__tests__/chat-tools.test.js` (and chat-staleness/chat-dedup
      suites if separate): `XPATH_TOOLS` no longer contains
      `read_document_version` and oversized-result paging guidance still fires
      for `read_document`; a `read_document` call WITH `versionId` does NOT
      record a staleness snapshot (`server/api/chat-staleness.js` both sites);
      chat-dedup keys `read_document` with `versionId` per
      `(docGuid, versionId, xpath, format)` and never lets a versioned read
      supersede a current read or vice versa. ALSO assert the derived chat tool
      set (chat-tools.js builds from `toolRegistry.getToolList()` at line ~456):
      it no longer contains `read_document_version` and DOES contain
      `import_markdown_file` — the latter is a conscious decision, not an
      accident: the in-app chat agent is shell-less, the recipe's `guidance`
      field (RBD-5) covers it, and the claim-secret residue class is identical
      to `create_access_token`, which chat already exposes (chat/MCP exposure
      partitioning is explicitly deferred by design amendment c790282).

### Implementation for User Story 6

- [X] T011 [US6] Extract the historical-read core from
      `server/mcp/tools/read-document-version.js` into a shared function in
      `server/mcp/tools/read-helpers.js`; add optional `versionId` to
      `server/mcp/tools/read-document.js` (schema property + handler branch:
      `documents.hasAccess` check, no presence session/highlights, version
      result shape); make `read-document-version.js` a thin delegate. Existing
      `read-document-version.test.js` keeps passing unmodified.
- [X] T012 [US6] `server/mcp/tools/index.js`: move `read_document_version` to a
      `HIDDEN_TOOL_ALIASES` map consulted by `getTool()` (out of `getToolList()`),
      keep its `TOOL_SCOPES` entry; DELETE the `get_tool_documentation` entry
      from `TOOL_SCOPES` (scope drop).
- [X] T013 [P] [US6] Description diet per contracts/teaching-surfaces.md §2 and
      research R9: `server/mcp/tools/undo.js` and `redo.js` to ~500 B each
      preserving every 016-asserted phrase (no "cursor"; "restart";
      per-identity; "preserved/untouched"; "clock");
      `server/mcp/tools/get-collaborators.js` banner-art removal (must land
      ≤ 2,048 B); delete prose PARAMETERS sections that restate schema property
      descriptions in `server/mcp/tools/read-document.js` and
      `server/mcp/tools/list-documents.js` (keep XPath examples); add the
      owner-only sentence to `server/mcp/tools/share-document.js`.
- [X] T014 [US6] Chat surfaces per contracts/read-document-merge.md:
      `server/api/chat.js` VERSION HISTORY workflow line → "read_document (with
      versionId) or compare_document_versions"; `server/api/chat-tools.js`
      `XPATH_TOOLS` drops `read_document_version`;
      `server/api/chat-staleness.js` snapshot-recording sites guard
      `!input.versionId` / `!args.versionId`; `server/api/chat-dedup.js`
      versionId-aware keys for `read_document`.

**Checkpoint**: 16 advertised tools; alias works; T003 byte gate green for every
tool except `modify` (and `create_document` stays under only until US2's
additions — finish both in Phase 5).

---

## Phase 5: User Story 2 — Trigger words reach schema-skimming agents (Priority: P1)

**Goal**: The pinned trigger words on every first-seen surface, funded by the
FR-012/FR-013 trims, with every changed surface under its byte budget.

**Independent Test**: quickstart.md §US2 — inspect tools/list + initialize as a
client; every pinned word present; byte test fully green.

### Tests for User Story 2 (write FIRST, must fail)

- [X] T015 [P] [US2] New suite
      `server/mcp/__tests__/tools/trigger-surfaces.test.js` per
      contracts/teaching-surfaces.md §1 and research R7: create_document title
      (first) line names syncing/importing an existing file as the excluded case
      (FR-009); description contains the already-read-it clause (FR-010);
      `inputSchema.properties.markdown.description` carries the
      don't-retype-existing-files redirect (FR-011); modify description contains
      "or syncing" and `mode=sync` (FR-013); modify NO LONGER carries the
      NON-NEGOTIABLE RULES duplication but still names XPath-not-positional and
      get_tool_documentation (trim guardrail); get_tool_documentation first line
      names the REST byte channel and `rest_api` (FR-014); `SERVER_INSTRUCTIONS`
      contains "to sync/import an existing file" (FR-015); per-surface byte
      re-assertions: create_document ≤ 2,048, modify ≤ 2,048, instructions
      ≤ 1,536 (SC-004 duplicates T003 deliberately — this suite documents the
      trigger contract on its own).

### Implementation for User Story 2

- [X] T016 [US2] Rewrite `server/mcp/tools/create-document.js` description +
      schema per FR-009/FR-010/FR-011/FR-012: new title line with the
      existing-file exclusion; add the already-read-it sentence to the
      byte-channel redirect; collapse WHY INCREMENTAL to one line; keep title
      precedence, at-least-one-of rule, parameter semantics; add the one-sentence
      redirect to the `markdown` param schema description; total ≤ 2,048 UTF-8
      bytes.
- [X] T017 [P] [US2] Trim + extend `server/mcp/tools/modify.js` description per
      FR-013: remove the NON-NEGOTIABLE RULES block (canonical home is
      get_tool_documentation), keep a one-line XPath/incremental pointer, extend
      the redirect to "Replacing or syncing content from an EXISTING markdown
      file? … PUT /api/docs/:docId/import (mode=replace / mode=sync)"; land
      ≤ 2,048 UTF-8 bytes (over cap today — this closes T003's last red).
- [X] T018 [P] [US2] `server/mcp/tools/get-tool-documentation.js`: headline
      (first line) names the REST byte channel + `rest_api` alongside the script
      tools (FR-014). `server/mcp/index.js` `SERVER_INSTRUCTIONS`: CHANNEL RULE
      sentence gains "to sync/import an existing file" (FR-015), total ≤ 1,536
      bytes.

**Checkpoint**: T003 + T015 fully green; both P1 stories delivered.

---

## Phase 6: User Story 3 — Nudge and soft refusal (Priority: P2)

**Goal**: create_document teaches at the moment of the mistake: nudge ≥ 2 KB,
instructive refusal ≥ 10 KB with always-honored `allowRetyped`, env-tunable with
misconfig fallback, zero change below the nudge threshold.

**Independent Test**: quickstart.md §US3 — bodies below/at/between/above
thresholds ± allowRetyped behave per the matrix.

### Tests for User Story 3 (write FIRST, must fail)

- [X] T019 [P] [US3] New suite
      `server/mcp/__tests__/tools/create-document-teaching.test.js` per
      contracts/teaching-surfaces.md §3: full matrix — sub-nudge call result
      DEEP-EQUALS pre-019 shape (no new fields, FR-021); at-nudge (exactly 2,048
      bytes) and in-band bodies succeed with the `POST /api/docs/import` pointer
      described as byte-faithful and receipt-verified (FR-018, boundary
      "at-or-above"); at/above refusal without allowRetyped → error, NO document
      created (count docs before/after), text names BOTH the byte-channel route
      and `allowRetyped: true` (FR-019); same call with `allowRetyped: true`
      succeeds and still carries the nudge (FR-020); `allowRetyped` on a small
      call is accepted and inert; multi-byte body: thresholds measured in UTF-8
      bytes not chars (a 3-byte-per-char body crossing 2,048 bytes at < 2,048
      chars gets the nudge, FR-017/US3 scenario 6); env-tunables:
      `CREATE_DOCUMENT_NUDGE_BYTES`/`CREATE_DOCUMENT_REFUSAL_BYTES` set/deleted
      per test (call-time read, research R3) change the trigger points; each
      misconfiguration (refusal ≤ nudge, zero, negative, non-numeric) falls back
      to BOTH defaults; `allowRetyped` present in `inputSchema` (boolean) so the
      registry unknown-param check passes.

### Implementation for User Story 3

- [X] T020 [US3] Implement in `server/mcp/tools/create-document.js`:
      `resolveTeachingThresholds()` per research R3 (call-time env read,
      pair-wise validation, defaults 2,048/10,240); measure
      `Buffer.byteLength(markdown, 'utf8')` BEFORE any side effect; refusal path
      throws the instructive error naming both routes and the escape hatch;
      nudge appended to the success `message`/result on ≥-nudge outcomes incl.
      allowRetyped creations; add `allowRetyped` (boolean) to `inputSchema` with
      a description stating it is only meaningful at/above the refusal
      threshold; sub-nudge path byte-identical.
- [X] T021 [US3] Verify SC-007: run
      `server/mcp/__tests__/tools/create-document.test.js` and
      `server/mcp/__tests__/create-document-markdown.test.js` UNMODIFIED — both
      must pass (their fixtures are sub-nudge; if any fixture is ≥ 2,048 bytes,
      that is a finding to resolve by threshold-neutral test env in the new
      suite only, never by editing the existing tests' assertions).

**Checkpoint**: teaching behavior complete and regression-proven.

---

## Phase 7: User Story 4 — First sync failure explains the way in (Priority: P2)

**Goal**: `sync_baseline_missing` carries the verbatim first-time remedy; other
rejection codes byte-identical.

**Independent Test**: quickstart.md §US4.

### Tests for User Story 4 (write FIRST, must fail)

- [X] T022 [P] [US4] Extend `server/__tests__/markdown-sync.rejection.test.js`
      (message-level) and `__tests__/integration/sync-push.route.test.js`
      (route-level 400 body) per contracts/teaching-surfaces.md §4: the
      `sync_baseline_missing` message includes the verbatim remedy sentence
      (FR-022/SC-008); the other three rejection messages are unchanged
      (snapshot the current strings); route-level: follow the remedy verbatim —
      initial import with `frontmatter=true`, write the receipt over the file,
      re-push with `mode=sync` → 200 (SC-008 second half).

### Implementation for User Story 4

- [X] T023 [US4] Append the remedy sentence to
      `REJECTION_MESSAGES.sync_baseline_missing` in
      `server/api/docs-import.js` (line ~78). One-string change; the other
      three entries untouched.

**Checkpoint**: highest-intent failure now self-serves.

---

## Phase 8: User Story 5 — agents.md answers the task by name (Priority: P3)

**Goal**: Published agents.md gains the task-named "Sync a repo file" recipe and
reflects the post-019 tool surface.

**Independent Test**: quickstart.md §US5 — fetch `/agents.md`, heading + four
steps present.

**Note**: depends on US1 (tool name to reference) and US6 (tool list accuracy).

### Tests for User Story 5 (write FIRST, must fail)

- [X] T024 [P] [US5] Extend `server/__tests__/agents-md-claims.test.js` per
      research R8: heading "Sync a repo file" exists; that section names (tolerant
      regexes) `import_markdown_file` (or minting a write-scoped token),
      `frontmatter=true` initial import, receipt write-back over the source
      file, and ongoing `mode=sync` pushes (FR-023/SC-005); tool-list claims:
      `import_markdown_file` listed; no standalone `read_document_version`
      listing (DR-1); `read_document` claim mentions versionId or versions.

### Implementation for User Story 5

- [X] T025 [US5] Edit `client/public/agents.md`: add the "Sync a repo file"
      section (four recipe steps, both entry points: the recipe tool and the
      manual mint path) near "## REST endpoints"; update "## Core tools" —
      remove `read_document_version` from the additional-tools list, note
      `read_document`'s optional `versionId`, add `import_markdown_file` with a
      task-shaped one-liner. Keep every existing drift-guarded claim intact
      (run `server/__tests__/agents-md-claims.test.js` after editing).

**Checkpoint**: all five spec stories + DR-1 delivered.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T026 [P] Update `README.md` per Constitution I: MCP tool list (~lines
      600–640) — add `import_markdown_file`, fold `read_document_version` into
      the `read_document` bullet (hidden alias noted), get_tool_documentation
      scope note; chat section "All 15 MCP document tools" count/wording
      (~line 496); mention the create_document nudge/refusal and the
      `CREATE_DOCUMENT_NUDGE_BYTES`/`CREATE_DOCUMENT_REFUSAL_BYTES` env vars
      where env config is documented.
- [X] T027 [P] Re-measure and record final byte sizes (all advertised
      descriptions + instructions) with a one-off
      `node -e` using `Buffer.byteLength`, confirm against implement-time
      `main` (spec Assumptions), and note the numbers in the feature's
      clarifications-needed.md DR-1/RBD-4 entries if they moved.
- [ ] T028 Run the FULL backend suite serially (`npm test -- --runInBand`) plus
      the quickstart.md automated block; fix any fallout. Verify
      `server/mcp/__tests__/tools/read-document-version.test.js`,
      `create-access-token.test.js`, `token-claim.test.js`, and all
      `markdown-sync.*` suites pass unmodified (SC-007/SC-009 umbrella).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (T001)**: none.
- **Phase 2**: T002 independent of T001; T003 needs T001. Blocks all stories.
- **Phase 3 (US1)**: needs T002 (helper) and T003 (byte gate covers the new
  description). MVP stops here.
- **Phase 4 (US6)**: needs Phase 2. Independent of US1 except the shared
  expected-tools list in tool-modules.test.js (T007 vs T009/T012 — whichever
  lands second sets the final 16-entry list).
- **Phase 5 (US2)**: needs Phase 4 (diet funds the byte room; T003 can only go
  fully green after T017). This is the one deliberate priority-order deviation.
- **Phase 6 (US3)**, **Phase 7 (US4)**: only need Phase 2; independent of each
  other and of US2/US6. US3 touches create-document.js like US2's T016 — run
  T016 before T020 or coordinate the edit (same file, sequential).
- **Phase 8 (US5)**: needs US1 (tool name) + US6 (tool list accuracy).
- **Phase 9**: needs everything above.

### Within Each Story

Tests first and failing → implementation → story checkpoint green. Same-file
tasks are sequential (create-document.js: T016 → T020; tools/index.js: T007 →
T012).

### Parallel Opportunities

- T004 + T005 (US1 tests); T009 + T010 (US6 tests); T013 alongside T011/T012
  (different files); T015 alongside T009/T010 once Phase 4 implementation is
  underway; T017 + T018 (different files, after T015 red); T019 and T022 and
  T024 are mutually independent; T026 + T027 in Polish.
- Whole stories runnable in parallel by different agents: US3, US4, US5(after
  US1/US6) — subject to the same-file notes above.

---

## Implementation Strategy

**MVP first**: Phases 1–3 (US1) deliver the core remedy for the founding retype
incident and are independently shippable. **Incremental delivery**: US6 → US2
completes the P1 pair under the byte gate; US3/US4 add the safety nets; US5 +
Polish close the loop. Each checkpoint leaves `main`-mergeable state: every
suite green except the deliberately-red T003 gate between Phase 2 and Phase 5 —
if intermediate merges are needed, land T003's byte conversion in the same merge
unit as Phases 4–5.

**Task count**: 28 (Setup 1, Foundational 2, US1 5, US6 6, US2 4, US3 3, US4 2,
US5 2, Polish 3).
