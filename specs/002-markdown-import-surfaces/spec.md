# Feature Specification: Markdown Import Surfaces

**Feature Branch**: `002-markdown-import-surfaces`

**Created**: 2026-07-13

**Status**: Draft

**Input**: User description: "M2 — Import surfaces from design/markdown-import-two-way-sync.md Part 1 §1.2: one shared import module (`server/markdown-import.js`) exposed through an MCP sandbox helper (`fromMarkdown`), an optional `markdown` parameter on `create_document`, and two REST routes (PUT `/api/docs/:docId/import`, POST `/api/docs/import`), with a fetch-and-rehost image policy and defensive frontmatter consumption."

**Ground truth**: `design/markdown-import-two-way-sync.md` (Part 1 §1.2, image policy note, M2 milestone row). Current-state references: `design/agent-surface-mcp.md`, `design/document-model-format-pipeline.md`.

**Depends on**: Feature 001 (M1 — parser generalization). This spec consumes `markdownToPm` as generalized by 001 (tolerant CommonMark + GFM subset, never-lose-content rule, HTML whitelist, relocation under `shared/`) and does not respecify any parser behavior. If 001 has not merged, this feature is blocked.

**Extended by**: Feature 003 (portable export / frontmatter emission — owns the `squire:` frontmatter contract this feature consumes defensively) and feature 004 (two-way sync — the PUT import route defined here is the transport 004 extends with clock-anchored merge).

## Trust Boundary & Validation Policy *(constitution Principle V — mandatory for new ingestion surfaces)*

**Trust boundary**: Every byte of imported markdown is untrusted input, regardless of channel — an `sk_sqd_` token holder, an OAuth-delegated agent, a CI script, or a file a user found on the internet. Import is a new write path from outside the app into document content; nothing about the caller's authentication makes the *content* trustworthy. The boundary sits at the import module: everything upstream (request body, tool argument, sandbox string) is hostile; everything the module writes into the Yjs fragment must already satisfy the same invariants the editor and modify pipeline enforce.

**Validation policy** (each item is a functional requirement below):

| Vector | Policy |
| --- | --- |
| Markdown text | Parsed only — never executed, never interpreted as HTML beyond feature 001's registry whitelist; unparseable input degrades to literal paragraphs (never-lose-content). |
| Authentication & authorization | All surfaces require an authenticated principal; scoped principals need `documents:write`; PUT additionally requires editor role on the target document; POST creates a document owned by the acting user. No anonymous surface. |
| Request size | Markdown bodies are size-capped (default 5 MB); oversized requests rejected before parsing. |
| External images (`http`/`https` src) | Fetched server-side and rehosted into app image storage under an SSRF-safe fetch policy (scheme allowlist, private/link-local/metadata address blocking on every redirect hop, size/type/count/time budgets). On any failure: degrade to a plain link — never leave an external `src` in the document. |
| `data:` image srcs | Rejected — never fetched, never stored, never written into the document; degrade to the image's alt text, reported to the caller. |
| App-URL images | Must pass the existing app-image guardrail; cross-document app URLs go through the existing access-checked copy-or-strip reconciliation. |
| Link hrefs | Protocol allowlist (`http`, `https`, `mailto`, app-relative). Dangerous protocols (`javascript:`, `data:`, `vbscript:`, `file:`) have the link mark dropped; link text is preserved. |
| Frontmatter | A leading `squire:` YAML block is consumed defensively: recognized fields used, unknown fields ignored, malformed YAML treated as ordinary content. Frontmatter never fails an import and never executes anything. |
| Server egress | Image fetching is the only network egress this feature introduces; it is bounded (count, bytes, redirects, wall-clock) so an import cannot be used as an amplification or scanning primitive. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a populated document from markdown in one call (Priority: P1)

An agent (via MCP) or a script (via REST) has a complete markdown document — an ADR, a PRD, a spec-kit output, an agent-drafted proposal — and wants it in Squire as a rich document. Today this requires creating an empty document and issuing many `modify` calls that hand-build blocks. With this feature, one call creates the document with all content materialized, titled from the markdown itself when no title is given.

**Why this priority**: This is the single biggest gap the design doc identifies — content cannot get *into* Squire. It is the on-ramp for migrating existing documents and for every "agent produced markdown, get it into Squire" workflow. It delivers value with no other story implemented.

**Independent Test**: Call `create_document` with a `markdown` argument (or POST a markdown body to the create-import route) and open the resulting document: all supported constructs render as rich blocks, the title matches the first heading, and the document is immediately editable and collaborative.

**Acceptance Scenarios**:

1. **Given** a valid MCP session with `documents:write`, **When** `create_document` is called with `markdown` containing a heading, paragraphs, nested lists, a table, a fenced mermaid block, and inline formatting, **Then** a new document exists whose body contains the corresponding rich blocks and whose version history shows one attributed entry for the creation.
2. **Given** `create_document` is called with `markdown` but no `title`, **When** the markdown's first heading is "Payments Redesign", **Then** the document title is "Payments Redesign" and the heading remains in the body.
3. **Given** an `sk_sqd_` token with `documents:write`, **When** a client POSTs a `text/markdown` body to the create-import route, **Then** the response contains the new document's id, title, URL, and clock, and the acting user owns the document.
4. **Given** markdown with a leading `squire:` frontmatter block containing a title, **When** it is imported via POST, **Then** the frontmatter block is not present in the document body and the title comes from the frontmatter.
5. **Given** markdown containing constructs Squire does not support (e.g. footnotes), **When** imported, **Then** the unsupported text appears as literal paragraphs — no content is silently dropped.

---

### User Story 2 - Import markdown into an existing document over REST (Priority: P2)

A script or CI job holds an `sk_sqd_` token and a markdown file, and wants to push it into an existing Squire document — either appending to the end (progress logs, generated sections) or replacing the whole body (regenerated docs). This route is also the transport that feature 004's clock-anchored sync will extend.

**Why this priority**: It completes the REST story (export has existed with no import counterpart) and unblocks the repo→Squire direction of the sync workflow this proposal exists to serve. It is independently valuable but less foundational than getting content in at all (US1).

**Independent Test**: PUT a markdown body at an existing document with `mode=append`, then again with `mode=replace`, verifying access control (viewer forbidden, editor allowed), the resulting document state, and the returned clock.

**Acceptance Scenarios**:

1. **Given** an editor-role principal with `documents:write`, **When** it PUTs markdown with `mode=append`, **Then** the parsed blocks are appended after the existing content, prior content and its attribution are untouched, and the response reports the new clock.
2. **Given** the same request with `mode=replace`, **When** it succeeds, **Then** the document body consists solely of the parsed blocks, the operation is a single undo step, and version history attributes the change to the acting principal.
3. **Given** a principal whose role on the document is viewer, **When** it PUTs markdown, **Then** the request is rejected with a permission error and the document is unchanged.
4. **Given** a token scoped only `documents:read`, **When** it PUTs markdown, **Then** the request is rejected with an insufficient-scope error.
5. **Given** a collaborator typing in the document during an `append` import, **When** the import lands, **Then** both edit streams apply cleanly (imports in append mode are pure insertions).
6. **Given** an empty or whitespace-only body, or an unknown `mode`, **When** PUT is called, **Then** the request is rejected with a validation error and no change occurs.

---

### User Story 3 - Agents compose markdown into precise document positions (Priority: P3)

An agent running a `modify` script has markdown in hand (quoted content, generated text) and wants it inserted at a specific place in a live document. Today the modify tool documentation ships a hand-rolled regex example for faking this. With the `fromMarkdown` sandbox helper, the script converts markdown to detached nodes and places them with the positioning primitives it already knows (`doc.insert`, `appendBlocks`-style targeting).

**Why this priority**: Quality-of-life for the agent surface. US1/US2 handle whole-document flows; this covers surgical composition inside live edits, replacing a documented workaround with a real primitive.

**Independent Test**: Run a modify script calling `fromMarkdown` and inserting its result after an XPath-located heading; verify the blocks land at that position with formatting intact and the manual regex example is gone from the tool documentation.

**Acceptance Scenarios**:

1. **Given** a modify script, **When** it calls `fromMarkdown("## Notes\n- item **bold**")` and inserts the result at a computed index, **Then** the document gains a heading and a bullet list with a bold run at that position, streamed live like any other script mutation.
2. **Given** the returned nodes, **When** the script inspects them before inserting, **Then** they behave as detached nodes with the same contract as `cloneBlocks` output (insertable anywhere, composable with existing positioning helpers).
3. **Given** the modify tool documentation, **When** an agent requests it, **Then** the markdown-conversion guidance demonstrates `fromMarkdown` and the manual regex example is removed.
4. **Given** malformed or empty markdown passed to `fromMarkdown`, **When** the script runs, **Then** the helper returns literal-text paragraph nodes (never-lose-content) or an empty array for empty input — it never throws on content it merely cannot structure.

---

### User Story 4 - Imported images arrive working and safe (Priority: P2)

Markdown from the outside world references images by external URL. Today the guardrail would strip them (content loss); leaving them external would make every viewer's browser fetch attacker-chosen URLs (tracking vector). With this feature, external images are fetched once by the server, stored in app image storage, and rewritten to app URLs — so imported documents look right and remain self-contained.

**Why this priority**: Ships with the same milestone as the surfaces (design M2 lists "image fetch-and-rehost" as a deliverable); without it, image-bearing imports silently degrade. Prioritized with US2 because real-world documents (READMEs, design docs) are image-heavy.

**Independent Test**: Import markdown referencing a reachable external image, an unreachable URL, a private-network URL, and a `data:` URL; verify exactly one rehosted app image, two plain-link/alt-text degradations, one rejection report, and zero external or `data:` srcs in the stored document.

**Acceptance Scenarios**:

1. **Given** markdown with `![diagram](https://example.com/d.png)` where the URL serves a 200 KB PNG, **When** imported, **Then** the document contains an image whose src is an app image URL, the bytes live in app image storage attributed to the acting user, and the import report lists the rehost.
2. **Given** an external image URL that fails (unreachable, over the size cap, wrong content type, too many redirects), **When** imported, **Then** the document contains a plain link (alt text or the URL as link text, href = original URL) in the image's place, and the failure is reported — the import itself still succeeds.
3. **Given** an image URL that resolves to a private, loopback, link-local, or cloud-metadata address — directly or via a redirect hop — **When** imported, **Then** the server never connects to that address and the image degrades to a plain link.
4. **Given** `![x](data:image/png;base64,...)`, **When** imported, **Then** no data URL is stored or fetched; the image degrades to its alt text and the rejection is reported.
5. **Given** an image src that is already an app image URL for another document the acting user can read, **When** imported, **Then** the existing cross-document reconciliation copies it into the target document (or strips it when inaccessible), identical to today's modify behavior.
6. **Given** the same external URL referenced five times in one import, **When** imported, **Then** it is fetched once and all five nodes share one rehosted copy.

---

### Edge Cases

- **Frontmatter only, no body**: for create, the document ends up with the seeded empty paragraph and a derived title; a PUT whose body yields zero blocks after frontmatter stripping is rejected as effectively empty.
- **Malformed YAML frontmatter**: treated as ordinary content (literal paragraphs); import never fails on frontmatter.
- **Non-`squire:` frontmatter keys**: preserved at the top of the body (as a fenced code block) so no content is lost; the portable round-trip representation is feature 003's contract.
- **`replace` on a document being edited live**: concurrent collaborator edits merge per CRDT semantics; edits inside removed blocks are lost with those blocks — this is the documented Principle IV exception (see Constitution Notes) and 004's clock-anchored merge is the eventual answer.
- **`insertAfterXPath` target not found**: the module errors without mutating the document (no partial import).
- **Import exactly at the size cap / one byte over**: at-cap succeeds; over-cap rejected before parsing with a clear too-large error.
- **Image fetch budget exhausted** (more external images than the per-import cap): remaining images degrade to plain links and the report says why.
- **Image storage not configured** (no S3): rehosting is impossible; all external images degrade to plain links, reported; import still succeeds.
- **Concurrent identical imports** (double-fired webhook/CI job): both apply; append duplicates content (caller's responsibility), replace converges; no corruption.
- **Huge single-line markdown / pathological nesting**: bounded by the size cap and feature 001's parser guarantees; import must not hang the request beyond the parse/fetch budgets.
- **CRLF input and BOM**: normalized; frontmatter detection still works.

## Requirements *(mandatory)*

### Functional Requirements

**Core import module — one code path for every surface**

- **FR-001**: The system MUST provide a single server-side import module — `importMarkdown(ydoc, markdown, { mode })` in `server/markdown-import.js` — that converts markdown to document content and materializes it into the live document (Yjs fragment). Every import surface in this feature MUST be a thin wrapper over this module; no surface may carry its own parsing or materialization logic.
- **FR-002**: The module MUST support three modes: `append` (insert parsed blocks after existing content), `replace` (document body becomes exactly the parsed blocks), and `insertAfterXPath` (insert parsed blocks immediately after the first element matching a structural XPath query; error without mutation when no match). Structural targeting MUST be XPath-based, never positional indexing (Principle IV).
- **FR-003**: The module MUST obtain ProseMirror JSON exclusively from the feature-001 generalized parser (`markdownToPm`) and MUST inherit its never-lose-content guarantee: any input yields a document whose plain text contains the input's text (worst case as literal paragraphs). Parser behavior itself is out of scope here (see Dependencies).
- **FR-004**: Each import MUST apply as a single transaction attributed to the acting identity (user, or agent-on-behalf-of-user), producing exactly one undo boundary and one attributed version-history entry, via the same update path as human edits (no privileged write path).
- **FR-005**: Empty or whitespace-only markdown MUST be rejected with a validation error on every surface except `fromMarkdown` (which returns an empty node array) — no silent no-op, no accidental `replace`-to-empty.

**Frontmatter (consuming feature 003's contract, defensively)**

- **FR-006**: When the markdown begins with a YAML frontmatter block containing a `squire:` key, the import MUST strip that block from the document body and MAY use its recognized fields (in this feature: `title` for title derivation). Unrecognized `squire:` fields MUST be ignored without error. The field contract is owned by feature 003; this feature MUST NOT fail on any frontmatter shape.
- **FR-007**: Frontmatter content other than the `squire:` key MUST be preserved at the top of the imported body (as a fenced code block) rather than dropped — spec-kit and static-site tooling own their own keys. Malformed YAML frontmatter MUST be treated as ordinary document content.

**MCP surfaces**

- **FR-008**: `create_document` MUST accept an optional `markdown` parameter. When present, the created document is seeded with the imported content, and `title` becomes optional. Title derivation precedence: explicit `title` argument → frontmatter `squire: title` → text of the document's first heading → `Untitled`. A heading used for the title MUST remain in the body (title is metadata; the body is not rewritten).
- **FR-009**: The modify sandbox MUST expose a `fromMarkdown(md)` helper that returns detached document nodes with the same contract as `cloneBlocks` output: insertable via existing positioning primitives, streamed like any other script mutation, built with the sandbox's tracked constructors. The helper MUST be synchronous and MUST NOT perform network access inside the sandbox.
- **FR-010**: The modify tool documentation (`server/mcp/tools/tool-documentation/modify.js`) MUST be updated to demonstrate `fromMarkdown` and MUST remove the manual regex-conversion example it replaces (Example 4, "Transform block types in place").

**REST surfaces**

- **FR-011**: The system MUST provide `PUT /api/docs/:docId/import` accepting a `text/markdown` (or `text/plain`) body with `mode=append|replace` (default `append`). Authentication follows the export route's model (browser sessions and `sk_sqd_` tokens); scoped principals MUST hold `documents:write`; the acting user MUST have the editor role on the document (owner qualifies). The route MUST be mounted beside the existing export router.
- **FR-012**: The system MUST provide `POST /api/docs/import` creating a new document from a `text/markdown` body, owned by the acting user; scoped principals MUST hold `documents:write`. Title derivation follows FR-008 (an explicit title may be supplied as a query parameter; otherwise frontmatter → first heading → `Untitled`).
- **FR-013**: Request validation: bodies over the size cap (default 5 MB) MUST be rejected as too large before parsing; unsupported content types MUST be rejected as unsupported media type; unknown `mode` values rejected as bad request; missing document / no access on PUT follows the export route's error behavior.
- **FR-014**: Responses MUST include: (PUT) the document id, applied mode, new document clock, a summary of blocks imported, and the image report; (POST) the new document id, title, URL, clock, and the image report. The response shape MUST be additive-extensible (feature 004 will extend PUT's response; nothing here may preclude that).
- **FR-015**: `insertAfterXPath` is a module capability (used by the sandbox and future callers) and MUST NOT be exposed as a REST mode in this feature — REST offers `append|replace` only, per the design doc.

**Image policy on import (see Trust Boundary above)**

- **FR-016**: External `http(s)` image references in imported markdown MUST be fetched server-side and rehosted into app image storage through the existing document-image path (existing size cap and MIME-type allowlist apply; bytes attributed to the acting user), and the image node's src rewritten to the resulting app URL. The stored document MUST never contain an external image src after import.
- **FR-017**: Image fetching MUST be SSRF-safe: `http`/`https` schemes only; the resolved address of the initial request and of every redirect hop MUST be validated against a blocklist of private (RFC 1918), loopback, link-local (including cloud metadata, e.g. 169.254.169.254), unique-local, and unspecified/multicast ranges, with the connection made to the validated address (no DNS-rebind window); redirects capped (default 3); per-fetch timeout (default 10 s); response size enforced while streaming against the existing image byte cap; declared content type checked against the existing image MIME allowlist.
- **FR-018**: Per-import fetch budget: at most a fixed number of unique external images are fetched per import (default 20), identical URLs deduplicated to one fetch and one stored copy. Images beyond the budget, and any fetch failure (network, size, type, SSRF block, storage disabled), MUST degrade to a plain link — link text = alt text if present else the URL, href = the original URL — and MUST be itemized in the import report with a reason. Image failures MUST NOT fail the import.
- **FR-019**: `data:` image srcs MUST be rejected: never fetched, never stored, never written into the document. The node degrades to its alt text as plain text (dropped when alt is empty) and the rejection is itemized in the import report.
- **FR-020**: Image srcs that are already app image URLs MUST pass the existing guardrail unchanged; app URLs pointing at a *different* document MUST go through the existing cross-document reconciliation (copy when the acting user can read the source document, strip otherwise).
- **FR-021**: The rehost policy applies to images entering through this feature's import surfaces (the import module, and `fromMarkdown`-produced nodes in modify scripts). The existing strip behavior for external srcs directly authored by scripts through other means (e.g. an `appendBlocks` image with an external src) is unchanged by this feature.
- **FR-022**: Link marks parsed from imported markdown MUST have their href validated against a protocol allowlist (`http`, `https`, `mailto`, app-relative paths). For any other protocol the link mark is dropped and the link text preserved.

**Consistency & documentation**

- **FR-023**: Round-trip invariant (import direction): importing the markdown export of any document into a fresh document MUST produce equivalent content (same plain text, same supported structure) — the precursor of feature 004's byte-stable CI property test.
- **FR-024**: `README.md` and the relevant MCP tool documentation (modify examples; REST import documented beside export in the `export_api` tool documentation) MUST be updated in the same effort (Principle I); format knowledge MUST NOT be duplicated outside the registry-driven parser/serializer (Principle IV).

### Key Entities

- **Import request**: the untrusted unit of work — markdown text plus mode and target (existing document, or "create"). Carries the acting principal (session, token, or agent delegation) whose scope, role, and attribution govern the whole import.
- **Import result / report**: what the caller gets back — target document identity, new clock, block summary, and an itemized image report (rehosted / degraded-to-link / rejected, each with a reason). This is the contract feature 004 extends.
- **Rehosted image**: an external image's bytes captured once into app image storage, owned by the target document, attributed to the acting user; referenced by app URL from one or more image nodes.
- **Frontmatter block**: an optional leading YAML block. Its `squire:` key is consumed (contract owned by feature 003); the remainder is preserved as content; malformed YAML is just content.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A markdown document (e.g. a real ADR or GitHub README) gets into Squire as a rich document with **one** API/tool call, replacing the current create-then-N-modify workflow (N ≥ 5 in the tool's own recommended flow) — a ≥ 80% reduction in calls for document migration.
- **SC-002**: Zero content loss across the import corpus: for every input in the tolerant-input test corpus (agent-generated specs, GitHub READMEs, spec-kit output, fuzzed markdown), the imported document's plain text contains the input's text.
- **SC-003**: 100% of documents produced or updated by import contain zero external (`http(s)`) and zero `data:` image srcs when inspected after import; every degraded or rejected image is itemized in the response.
- **SC-004**: SSRF probes (private, loopback, link-local, metadata addresses; redirect-based and DNS-based) result in zero server connections to blocked address ranges in the test suite.
- **SC-005**: Importing a 1 MB markdown document with no external images completes in under 5 seconds; with 10 external images (1 MB each, responsive hosts) in under 30 seconds.
- **SC-006**: An append-mode import into a document being concurrently edited produces both edit streams intact (no lost human keystrokes) in the collaboration test.
- **SC-007**: For every existing test document, export → import into a fresh document → compare yields equivalent text and structure (round-trip property, squire flavor).
- **SC-008**: The modify tool documentation contains no manual regex markdown-conversion example; the documented path is `fromMarkdown`.

## Constitution Notes

- **Principle IV tension — `replace` mode (explicit flag)**: `replace` is wholesale by definition and sits in tension with "targeted ops, never delete-and-recreate". Ground truth (design §1.2) still specifies it: it is the honest primitive for "regenerated file, make the doc match" until feature 004's clock-anchored merge exists. Resolution adopted: `replace` is the **documented exception**, constrained to stay as collaboration-safe as feasible — a single transaction of block-level deletes plus inserts against the live fragment (no fragment or document recreation; document identity, metadata, and title untouched), one undo step, fully attributed; concurrent edits merge per CRDT semantics rather than erroring, with edits inside removed blocks lost alongside those blocks. The plan phase MUST carry this in its Complexity Tracking table, and feature 004 is the designated successor for merge-quality replace.
- **Principle V**: satisfied by the Trust Boundary & Validation Policy section above.
- **Principle II**: behavioral changes here require API-level tests (auth/scope/role matrices, modes, size/type limits), SSRF unit tests with address-family coverage, image-degradation tests, sandbox-helper tests, and the SC-007 round-trip property; backend suites run serially against the shared DB.
- **Principle VI**: one current-state contradiction found and ledgered (the design doc calls `documents:write` a *new* scope; it already exists in the token/tool infrastructure — only REST-route enforcement of it is new). See `clarifications-needed.md`.

## Assumptions

- Feature 001 lands first and delivers: tolerant `markdownToPm`, the never-lose-content rule, the HTML whitelist, and (per design §1.2 shared-code note) the parser importable server-side. This feature consumes it as a black box.
- The `documents:write` scope already exists for `sk_sqd_` tokens and MCP principals (it is in the default token scopes and required by MCP write tools today); this feature only adds REST-route enforcement of it. Browser-session principals carry no scope array and pass scope checks by design, gated by document role instead.
- Task lists (`- [ ]`) degrade to bullet lists until feature 003's schema work lands (design §1.1 sequencing); this feature inherits whatever the parser emits.
- Existing image storage limits govern rehosted images: 15 MB per image, MIME allowlist png/jpeg/gif/webp. When image storage is unconfigured, rehosting degrades to plain links (parity with the cross-doc reconciler's no-op posture).
- Existing global infrastructure protections are sufficient for v1; the per-import fetch budget is the abuse bound this feature adds. No new rate limiter is introduced.
- The seeded empty paragraph on `create_document` (presence-cursor anchor) remains for empty creates; markdown-seeded creation seeds real content in its place and must preserve the presence behavior that motivated it.
- The PUT route must not preclude feature 004's extension (clock parameter, canonical re-export in the response, overlap flags), but implements none of it.

## Out of Scope

- Parser grammar, dialect tolerance, HTML passthrough rules — feature 001.
- `squire:` frontmatter field contract and any frontmatter *emission* — feature 003.
- Clock-anchored push/merge, source maps, overlap flags — feature 004 (this feature's PUT route is its transport).
- Editor paste conversion and any client-side import surface — M5.
- Webhooks or triggers for import; new rate-limiting infrastructure; per-document token scoping (design open question 4).
