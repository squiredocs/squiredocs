# Tasks: Markdown Import Surfaces

**Input**: Design documents from `/specs/002-markdown-import-surfaces/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (import-module.md, rest-import.md, image-rehost.md), quickstart.md

**Tests**: INCLUDED — the spec mandates them (Constitution Principle II; spec §Constitution Notes lists the required suites). Backend suites run **serially** against the shared DB (`--runInBand`; never concurrent).

**Organization**: By user story. Phase order deviates from raw priority in one place: **US4 (P2, images) runs before US3 (P3, sandbox)** because US3's modify-pass rehost integration consumes US4's rehost module.

**Hard dependency**: Feature 001 must be merged (tolerant `markdownToPm` under `shared/`, client-safe). If T001 finds it absent, STOP — this feature is blocked by design.

**Migration**: **NONE.** This feature adds no node-pg-migrate migration (research.md R7 — image rows reuse `document_images`; the import report is transient). If implementation ever appears to need one, escalate to the orchestrator first; do not add one unilaterally.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 for user-story phases only

---

## Phase 1: Setup

**Purpose**: Verify the 001 contract and stage shared fixtures.

- [x] T001 Verify feature-001 deliverables this feature consumes: `shared/markdown-to-pm.js` exists and exports `markdownToPm` with tolerant default + never-lose-content + HTML whitelist, and is client-safe (no Node built-ins — required for the sandbox bundle). Also confirm `shared/format-registry.js` relocation and that `server/diff-service.js` still passes. If any check fails, STOP and report the blocker (spec §Depends on).
- [x] T002 [P] Create import test fixtures in `server/__tests__/fixtures/import/`: a realistic ADR/README sample, frontmatter variants (squire-only, mixed, malformed, non-squire-only, frontmatter-only), image-bearing markdown (external/`data:`/app-URL/duplicated srcs), dangerous-link samples (`javascript:`/`data:`/`vbscript:`/`file:` hrefs), CRLF+BOM sample, and an unsupported-construct (footnote) sample.

**Checkpoint**: 001 contract confirmed; fixtures available to every suite.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: The single import code path (FR-001) every surface wraps. No user story starts before this completes.

- [x] T003 Implement frontmatter consumption in `server/markdown-import-frontmatter.js`: BOM strip + CRLF normalization; detect leading `---` YAML block at absolute start; extract `squire:` recognized fields (`title` only), ignore unknown `squire:` keys; re-emit non-`squire:` keys as a leading fenced `yaml` code block string; malformed YAML ⇒ return input unchanged as content. Never throws (FR-006/007, CN-5, contracts/import-module.md §Behavior 1–2).
- [x] T004 [P] Unit tests for frontmatter in `server/__tests__/markdown-import-frontmatter.test.js`: squire title extraction, unknown squire fields ignored, residue-as-yaml-block, squire-only leaves no residue, malformed YAML treated as content, frontmatter-only input, CRLF/BOM detection still works (fixtures from T002).
- [x] T005 Implement the PM-JSON→Yjs materialization seam `pmJsonToNodes(pmJson, { XmlElement, XmlText })` in `server/mcp/yjs/pm-json-to-nodes.js` (research R1 two-step): materialize into a scratch `Y.Doc` via `y-prosemirror` + `shared/prosemirror-schema.js`, then return **detached** nodes via `helpers.cloneNodes(scratchFragment, { XmlElement, XmlText })` — the options-object constructor pattern is what lets the sandbox pass its tracked constructors (server callers pass plain `Y.*`). Must preserve every registry mark, nested lists, tables, mermaid/svg, images, hard breaks.
- [x] T006 [P] Unit tests for materialization in `server/__tests__/pm-json-to-nodes.test.js`: each registry mark and block type from parser output survives into Yjs nodes (drive via `markdownToPm` on canonical serializer samples; assert `toMarkdown(materialized)` equivalence — the mini round-trip).
- [x] T007 Implement link-href sanitation in `server/markdown-import.js` (exported helper `sanitizeLinkMarks(pmJson)`): protocol allowlist `http`/`https`/`mailto`/app-relative after trimming control+whitespace chars, case-insensitive; disallowed ⇒ drop the link mark, keep text (FR-022, CN-9).
- [x] T008 Implement `importMarkdown(ydoc, markdown, options)` in `server/markdown-import.js` per `contracts/import-module.md`: pipeline normalize → frontmatter (T003) → `markdownToPm` → link sanitation (T007) → `data:`-image rejection to alt text (FR-019, CN-6) → materialize (T005) → apply mode inside ONE `documentService.updateDocument` transaction — `append` (insert at end), `replace` (delete existing top-level blocks + insert, same fragment, never recreate — plan.md Complexity Tracking), `insertAfterXPath` (resolve via `server/mcp/sandbox/xpath.js` FIRST; no match ⇒ throw before mutation) — with empty-result guard before mutation (FR-005, CN-11); baseline image pass: same-doc app URLs untouched, cross-doc via existing `reconcileCrossDocImages` (`server/mcp/image-validate.js`), external `http(s)` degrade to plain link with reason (rehost arrives in US4 via a pluggable pass), `data:` already rejected; assemble `{ blocks, images, frontmatter }` report (data-model.md §4–5).
- [x] T009 Unit/DB tests for the module in `server/__tests__/markdown-import.test.js`: all three modes; single transaction = one undo boundary + one attributed version entry (FR-004); `insertAfterXPath` no-match mutates nothing; empty and frontmatter-only inputs rejected pre-mutation; `replace` leaves doc identity/meta/title intact; never-lose-content on fixture corpus (SC-002 sample); link-href sanitation through the module path — dangerous protocols dropped, text kept, allowed protocols survive (FR-022, T002 fixtures); report shape.

**Checkpoint**: `importMarkdown` fully functional and tested — user stories can begin.

---

## Phase 3: User Story 1 — Create a populated document from markdown in one call (P1) 🎯 MVP

**Goal**: One call (MCP `create_document` with `markdown`, or REST POST) creates a fully populated, titled, attributed document.

**Independent Test**: `create_document({ markdown })` / POST a markdown body → document exists with rich blocks, derived title, heading retained, one attributed version entry (spec US1).

- [x] T010 [US1] Implement `POST /api/docs/import` in new `server/api/docs-import.js` (`createImportRouter(persistence)`): `requireAuth`; content-type gate `text/markdown`/`text/plain` else 415; raw body with 5 MB limit ⇒ 413 (CN-1/2); empty ⇒ 400; title derivation `?title=` → frontmatter → first heading → `Untitled` (FR-008/012); create via `documentService.createSeededDocument` (owner = acting user) then `importMarkdown` mode `append`; 201 response per `contracts/rest-import.md` (docId, title, url, clock, images). Errors mirror the export route (`notifyException`, no existence oracle).
- [x] T011 [US1] Mount the import router in `server/index.js` immediately beside `createExportRouter` (~line 1098): `app.use(createImportRouter(persistenceProvider))` (FR-011 "mounted beside the existing export router").
- [x] T012 [US1] Extend `create_document` in `server/mcp/tools/create-document.js`: add optional `markdown` to `inputSchema`, make `title` optional with an at-least-one-of validation; when `markdown` present, seed with imported content instead of the empty anchor paragraph (preserve the presence-cursor rationale — seeded real content is the anchor; keep the empty paragraph only for markdown that yields zero blocks... which is rejected, so: empty-create path unchanged); title precedence per FR-008 (heading stays in body); extend the return with `blocks` and `images` (contracts/import-module.md §create_document).
- [x] T013 [P] [US1] Integration tests for POST in `__tests__/integration/docs-import-api.test.js`: 401 no token; 403 `INSUFFICIENT_SCOPE` for a `documents:read`-only token; 415 wrong content type; 413 over 5 MB (and at-cap succeeds); 400 empty/frontmatter-only; frontmatter title + residue yaml block; first-heading title fallback; `Untitled` fallback; owner = acting user; response shape incl. clock; session-cookie principal also accepted.
- [x] T014 [P] [US1] Tool tests in `server/mcp/__tests__/create-document-markdown.test.js`: markdown-only call derives title and body; explicit title beats frontmatter beats heading; heading retained in body; one attributed version entry; title-only call unchanged (regression); neither title nor markdown ⇒ validation error.
- [x] T015 [US1] Round-trip property test (FR-023/SC-007) in `server/__tests__/import-roundtrip.test.js`: for each existing test document (and T002 fixtures), `toMarkdown(doc)` → import into fresh doc → compare plain text + block structure equivalence; document the allowed normalizations (title/heading rule, task-list degradation per 001 CN-3).

**Checkpoint**: MVP — content can get into Squire in one call, fully tested.

---

## Phase 4: User Story 2 — Import into an existing document over REST (P2)

**Goal**: `PUT /api/docs/:docId/import` with `mode=append|replace`, editor-gated, additive-extensible response.

**Independent Test**: PUT append then replace against an existing doc; verify access matrix, resulting state, returned clock (spec US2).

- [x] T016 [US2] Implement `PUT /api/docs/:docId/import` in `server/api/docs-import.js`: same body/type/size/empty gates as POST; `mode` query `append` (default) | `replace`, anything else 400 (FR-013, CN-3); editor-role gate `documents.hasRole(docId, userId, 'editor')` ⇒ else 403 with export-parity message; call `importMarkdown`; 200 response `{ docId, mode, clock, blocks, images }` — additive-extensible, nothing precluding 004's fields (FR-014, CN-12).
- [x] T017 [US2] Extend `__tests__/integration/docs-import-api.test.js` with the PUT matrix: append preserves prior content + prior attribution and returns new clock; replace = exactly the new blocks, one undo step, attributed to acting principal; viewer 403; `documents:read`-only token 403 INSUFFICIENT_SCOPE; unknown mode 400; empty body 400 with doc unchanged; missing doc 403; owner passes the editor gate; `text/plain` accepted.
- [x] T018 [US2] Concurrency test (SC-006) in `__tests__/integration/docs-import-concurrency.test.js`: apply simulated collaborator updates to the shared ydoc while an `append` import runs; assert both edit streams present afterward (append is pure insertion); also assert double-fired identical appends both apply (edge case: concurrent identical imports).

**Checkpoint**: REST story complete — export finally has its import counterpart.

---

## Phase 5: User Story 4 — Imported images arrive working and safe (P2)

**Goal**: SSRF-safe fetch-and-rehost per `contracts/image-rehost.md`; every failure degrades to a plain link and is itemized.

**Independent Test**: import markdown with reachable/unreachable/private/`data:`/duplicated image refs → exactly one rehost, degradations with reasons, zero external or `data:` srcs stored (spec US4).

- [x] T019 [US4] Implement the address validator in `server/image-rehost.js`: `isBlockedAddress(ip)` covering the normative v4/v6/v4-mapped ranges in `contracts/image-rehost.md` §2 (incl. metadata 169.254.169.254, CGNAT, NAT64), literal-IP hostnames validated via `net.isIP` after URL normalization; `PolicyError` with the stable reason strings.
- [x] T020 [US4] Implement `safeFetchImage(url, opts)` in `server/image-rehost.js`: http/https only; resolve → validate ALL candidate IPs → **pin the connection to the validated IP** (host header/SNI from the original hostname; no re-resolution between check and connect); revalidate every redirect hop (max 3); 10 s abort; streaming byte cap at `documentImages.MAX_IMAGE_BYTES` (+ early Content-Length reject); content-type vs `ALLOWED_IMAGE_MIME_TYPES` (params stripped); no cookies/auth/proxy; Node core / undici only — zero new deps (research R4).
- [x] T021 [US4] Implement `rehostImagesInFragment(target, { docId, userId })` in `server/image-rehost.js`: collect external-src image nodes; normalize + dedup URLs; enforce the 20-unique budget (excess ⇒ `budget-exhausted`); `s3Images.isEnabled()` false ⇒ all degrade `storage-disabled`; fetch via T020, store via `documentImages.storeImage` (attribution = acting user), rewrite node `src` to the app URL (N nodes share one copy); on any PolicyError degrade the node to a plain link (text = alt || URL, href = original); return the ImageReport. Then wire it into `importMarkdown`'s image pass in `server/markdown-import.js`, replacing the Phase-2 baseline external-degrade (FR-016/017/018).
- [x] T022 [US4] SSRF + rehost unit tests in `server/__tests__/image-rehost.test.js` (no real network — injected lookup/connect/response fakes): every blocked range family rejects and globals pass; redirect-to-metadata blocked with **zero connection attempts** to the blocked address (SC-004); pinned-connect asserts connected IP === validated IP (rebind immunity); streaming cap aborts mid-body; content-type reject; dedup (5 refs ⇒ 1 fetch, 1 stored copy) and budget (21 unique ⇒ 20 fetches + 1 degradation); storage-disabled path; PolicyError reasons stable.
- [x] T023 [US4] Image-policy integration test through the REST surfaces (extend `__tests__/integration/docs-import-api.test.js`): mixed-image fixture through POST and PUT ⇒ report itemizes 1 rehosted (row in `document_images`, uploader = acting user) + degradations with reasons + `data:` rejection; re-export shows zero external/`data:` srcs (SC-003); cross-doc app-URL copies via existing reconciliation (FR-020); import still 2xx despite failures (FR-018).

**Checkpoint**: Image-bearing imports look right and are safe; only the modify-surface tie-in remains.

---

## Phase 6: User Story 3 — Agents compose markdown into precise positions (P3)

**Goal**: `fromMarkdown(md)` sandbox helper with the `cloneBlocks` contract; modify docs demonstrate it; import-origin external images rehost after the script.

**Independent Test**: modify script inserts `fromMarkdown` output after an XPath-located heading; blocks land with formatting intact; regex example gone from tool docs (spec US3).

- [x] T024 [US3] Expose `fromMarkdown` in `server/mcp/sandbox/isolate-entry.js`: bind `markdownToPm` + `sanitizeLinkMarks` + `data:`-rejection + `pmJsonToNodes` with the tracked constructors (`WrappedXmlElement`/`WrappedXmlText`); synchronous; `''`/whitespace ⇒ `[]`; unstructurable input ⇒ literal-text paragraph nodes, never throws (FR-009, CN-11); tag externally-srced image nodes with the transient import-origin marker for the host pass (research R3). Confirm the parser bundles cleanly (client-safe from T001).
- [x] T025 [US3] Rebuild the sandbox bundle: `npm run build:sandbox-bundle` (regenerates `server/mcp/sandbox/isolate-bundle.js`; generated file — never hand-edit; commit the rebuilt bundle).
- [x] T026 [US3] Extend the post-script image pass in `server/mcp/tools/modify.js`: nodes carrying the import-origin tag get `rehostImagesInFragment` treatment (rehost or degrade-to-link) with the tag consumed/removed either way; untagged external srcs keep today's `sanitizeImageSrcs` strip (FR-021, CN-8); surface the rehost/degrade outcomes in the modify response alongside the existing `imagesCopied`/`imageErrors`.
- [x] T027 [P] [US3] Sandbox helper tests in `server/mcp/sandbox/__tests__/from-markdown.test.js`: output insertable via `doc.insert` and `appendBlocks`-style positioning exactly like `cloneBlocks` output; mutations stream (operation tracking fires); formatting/marks intact; empty ⇒ `[]`; malformed ⇒ literal paragraphs; dangerous link hrefs dropped; `data:` images never present in returned nodes; external images tagged.
- [x] T028 [US3] modify-pipeline test for the rehost tie-in (extend `server/mcp/__tests__/` modify integration coverage): script inserts `fromMarkdown` with an external image ⇒ post-pass rehosts (fake fetch) or degrades; a direct `appendBlocks` external-src image in the same script is still stripped (FR-021 boundary).
- [x] T029 [US3] Update modify tool documentation in `server/mcp/tools/tool-documentation/modify.js`: remove Example 4 ("Transform block types in place" manual regex conversion, lines ~570–626) and replace with a `fromMarkdown` example (convert + insert after an XPath-located heading); add `fromMarkdown` to the helper reference (FR-010, SC-008).

**Checkpoint**: All four surfaces live; every user story independently testable.

---

## Phase 7: Polish & Cross-Cutting

- [x] T030 [P] Document the REST import beside export in `server/mcp/tools/tool-documentation/export-api.js`: PUT/POST routes, modes + default, content types, 5 MB cap, `documents:write` scope note, curl examples, image-report semantics (FR-024, contracts/rest-import.md §Documentation duty).
- [x] T031 [P] Update `README.md`: import surfaces (MCP param, sandbox helper, REST routes), image fetch-and-rehost policy summary, frontmatter behavior (Principle I / FR-024).
- [x] T032 Record the design-doc amendment flags in `specs/002-markdown-import-surfaces/promotion-notes.md` for the maintainer's Squire-source edit + `design/sync.mjs` re-sync (never hand-edit `design/`): (a) CN-10 — §1.2 already carries the 2026-07-13 spec-phase correction on `documents:write`; confirm final wording matches shipped behavior, noting REST scope enforcement for mutating methods pre-existed in `requireAuth` (research R6); (b) CN-9 — link-href sanitization gap is import-only-protected; global guardrail proposed as follow-up amendment.
- [x] T033 Performance validation (SC-005): timing assertions or a documented quickstart run — 1 MB no-image import < 5 s; 10-image import path exercised with fakes for determinism; note real-host numbers in the PR/commit description.
- [ ] T034 Full serial backend suite + quickstart pass: run affected Jest suites `--runInBand`, then walk `specs/002-markdown-import-surfaces/quickstart.md` scenarios 1–6 in the dev pod; fix drift found.

---

## Dependencies & Execution Order

```
T001 ──► Phase 2 (T003..T009) ──► US1 (T010..T015) ──► US2 (T016..T018)
T002 ─┘                                             └► US4 (T019..T023) ──► US3 (T024..T029) ──► Polish (T030..T034)
```

- **Setup → Foundational**: T001 gates everything (001 contract). T003/T005/T007 are independent [P-able]; T008 needs T003+T005+T007; T009 needs T008.
- **US1 first (MVP)**: T010 needs Phase 2; T011 needs T010; T012 needs Phase 2; T013/T014 after their targets; T015 after T010/T012.
- **US2** reuses the router (T016 in the same file as T010 — sequential, not [P]).
- **US4 before US3** (deliberate priority-order deviation): T026/T028 consume T021's rehost module. Within US4: T019 → T020 → T021; T022 after T020; T023 after T021.
- **US3**: T024 → T025 (bundle rebuild) → T027/T028; T026 needs T021+T024; T029 anytime after T024.
- **Critical path**: T001 → T003/T005/T007 → T008 → T009 → T010 → T011 → T013 (MVP) → T016 → T021 → T024 → T025 → T034.

## Parallel opportunities

Single-implementer worktree, so [P] mainly means "safe to interleave without rework":
- Phase 1: T002 alongside T001.
- Phase 2: T003, T005, T007 concurrently; T004 ∥ T006 once their targets exist.
- US1: T013 ∥ T014 (different files); T012 ∥ T010.
- US4: T022 while T021 is wired; Polish: T030 ∥ T031.

## Implementation strategy

**MVP = Phase 1 + 2 + US1** (T001–T015): content gets into Squire in one call, with the safe baseline image posture (externals degrade to links — already spec-legal when storage is off). Then US2 (REST completeness), US4 (image quality + SSRF hardening), US3 (agent ergonomics), Polish (docs — required before merge per Principle I, not optional).

Each checkpoint leaves the tree green: run the affected suites serially before moving on; commit per task or logical group (worktree merge-queue runs the authoritative verification).
