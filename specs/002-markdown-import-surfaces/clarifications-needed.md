# Clarifications Ledger — 002-markdown-import-surfaces

Decisions the design doc does not settle. Per constitution Principle VI, each got the
best default and is recorded here rather than blocking. All entries below are
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)** unless later overturned; overturning
one is a spec amendment, not a code-level choice.

---

## 1. Markdown body size limit

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: The design says "size limits" for the REST import body but names no number.
- **Why it matters**: Bounds parser CPU/memory on untrusted input and defines the largest importable document.
- **Chosen default**: 5 MB for `text/markdown` bodies (both routes and the `markdown` tool parameter), rejected before parsing.
- **Rationale**: An order of magnitude above any realistic document (this design doc is ~20 KB) while far below the 150 MB chat-route limit; images don't ride in the body (they are fetched separately), so multi-MB markdown is already pathological.

## 2. Default and allowed content types

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: Design says "Body: text/markdown" — is that exclusive, and what happens on mismatch?
- **Why it matters**: Curl/CI ergonomics vs. strictness; silent misparse of JSON bodies would be confusing.
- **Chosen default**: Accept `text/markdown` and `text/plain` (UTF-8); any other content type → 415.
- **Rationale**: `text/plain` is what naive `curl --data-binary @file.md` often sends; both are unambiguous text. Rejecting `application/json` etc. prevents accidentally importing a JSON envelope as literal text.

## 3. Default mode for PUT

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: `mode=append|replace` — which applies when the parameter is omitted?
- **Why it matters**: The default determines the blast radius of a lazy call; `replace` is destructive.
- **Chosen default**: `append`.
- **Rationale**: Principle IV bias — the non-destructive option must be the one you get by accident. `replace` requires explicit opt-in.

## 4. Title derivation precedence and heading retention

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: Design says "title from frontmatter squire: block or first heading" — exact precedence, fallback, and whether a title-donor heading is removed from the body.
- **Why it matters**: Round-trip consistency with exports (design/ files keep their `# Heading` in the body while the doc has a title) and predictable one-call creation.
- **Chosen default**: explicit `title` argument → frontmatter `squire: title` → first heading's text → `Untitled`. The heading always stays in the body (title is metadata; body not rewritten).
- **Rationale**: Matches how synced exports already look (H1 in body, matching title in meta) and keeps `import(export(doc))` from deleting the document's visible heading.

## 5. Representation of non-`squire:` frontmatter

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: Design §2.3 says non-Squire frontmatter is "preserved as-is at the top of the doc body" — in what node form, given there is no frontmatter node type?
- **Why it matters**: Never-lose-content vs. rendering something sensible; feature 003 needs a representation it can re-emit as frontmatter.
- **Chosen default**: Preserve the frontmatter block minus the `squire:` key as a fenced `yaml` code block at the top of the body; if only `squire:` keys existed, nothing is retained.
- **Rationale**: Lossless, visually honest, and mechanically recoverable by 003 (a leading yaml code block is trivially re-emittable as frontmatter). Flagged to feature 003 as the representation to consume.

## 6. `data:` image handling under never-lose-content

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: Task and Principle V say `data:` srcs are rejected, but the design's never-lose-content rule says imports never lose content. A data URL *is* content (embedded bytes).
- **Why it matters**: Embedding megabytes of base64 as literal text would satisfy the letter of never-lose-content while producing garbage documents; storing the bytes would violate the data:-rejection policy.
- **Chosen default**: The binary payload is dropped; the image degrades to its alt text (dropped entirely when alt is empty) and the rejection is itemized in the import report. Never-lose-content is scoped to *textual* content.
- **Rationale**: The report keeps the loss visible and actionable (caller can upload via the image API); base64 blobs as body text help no one. Documented as a deliberate, narrow exception to the never-lose-content rule.

## 7. SSRF and fetch-budget parameters

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: The design says "size-capped, content-type-checked" and the task adds "SSRF-safe: block private/link-local"; no concrete parameters are given.
- **Why it matters**: These numbers are the abuse bound of the only new server egress; too loose is a scanning/amplification primitive, too tight breaks real documents.
- **Chosen default**: http/https only; block RFC 1918, loopback, link-local (incl. 169.254.169.254 metadata), unique-local, unspecified/multicast — validated per redirect hop with the connection pinned to the validated address; max 3 redirects; 10 s per-fetch timeout; per-image size = existing 15 MB image cap enforced while streaming; content type must be in the existing png/jpeg/gif/webp allowlist; max 20 unique external images per import, identical URLs deduplicated; excess and failures degrade to plain links.
- **Rationale**: Reuses the app's existing image limits rather than inventing parallel ones; 20 images covers real READMEs/design docs; every bound fails soft (link fallback) so no document is rejected for its images.

## 8. Scope of the rehost policy (import-only vs. all agent writes)

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: Should fetch-and-rehost replace the strip guardrail for *all* agent-written external image srcs (e.g. `appendBlocks` with an external URL), or only for images arriving via import surfaces?
- **Why it matters**: A uniform policy is simpler to explain and strictly better UX, but it changes the documented contract of `modify` and widens the server-egress surface beyond this feature's mandate ("Image policy on import").
- **Chosen default**: Import surfaces only (the import module and `fromMarkdown`-produced nodes). Directly authored external srcs keep today's strip behavior.
- **Rationale**: Ground truth scopes the policy to import ("Import should instead fetch-and-rehost…"); minimal blast radius for M2. Extending rehosting to all modify output is a candidate follow-up amendment to the design doc, not an ad-hoc code decision.

## 9. Link href protocol policy (gap not covered by the design doc)

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: The design doc's import trust discussion covers images and HTML passthrough but is silent on link hrefs; no href sanitization exists in the schema, registry, or editor extensions today. What happens to `[x](javascript:alert(1))` in imported markdown?
- **Why it matters**: Import is the first surface feeding *bulk untrusted* markdown into documents; a `javascript:` href is a stored-XSS-shaped hazard for every future viewer click. Material silence in ground truth → flagged here per Principle VI.
- **Chosen default**: On import, allow `http`, `https`, `mailto`, and app-relative hrefs; for anything else drop the link mark and keep the text.
- **Rationale**: Cheap, lossless for text, and consistent with Principle V's secure-by-default posture. NOTE: this protects the import path only — the absence of any global href guardrail (editor, modify scripts) is a pre-existing gap outside this feature's scope, flagged for a design-doc amendment.
- **UPDATE — Sam (2026-07-13, D-6)**: allowlist promoted from import-only to all agent write boundaries (modify post-pass). The validator (`isAllowedLinkHref`) was extracted to `shared/link-protocol.js` and is now enforced at the modify write boundary over the live Yjs fragment (`server/mcp/image-validate.js` → `sanitizeLinkHrefs`, reported as `linkErrors`), in addition to the import PM-JSON path (`sanitizeLinkMarks`, run in all three materialization paths: REST/create import, two-way sync, and `fromMarkdown`). Undo/redo and `restore_document_version` are explicitly out of scope — they replay previously-stored state and author no new hrefs (documented in code). The editor's own WebSocket edit path cannot be content-inspected server-side and remains render-time-gated by the client TipTap Link extension by design (accepted residual).

## 10. Design-doc staleness: "documents:write (new scope)"

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: Design §1.2 says PUT "requires `documents:write` scope (new; today only `documents:read` exists for export)". The codebase already defines `documents:write` — it is in `sk_sqd_` tokens' DEFAULT_SCOPES (`server/mcp/auth/api-tokens.js`) and required by every MCP write tool (`server/mcp/tools/index.js`).
- **Why it matters**: Principle VI: design docs win over code, but this is a *current-state* factual claim the code falsifies; specifying a "new scope" would create a duplicate.
- **Chosen default**: No new scope is created. The feature enforces the *existing* `documents:write` scope on the new REST routes (the genuinely new part is REST-route enforcement). The design doc sentence should be amended at the source Squire doc and re-synced as part of this effort's doc pass — not hand-edited.
- **Rationale**: The doc's intent ("write access must be scoped") is fully honored; only its parenthetical about current state is stale.

## 11. Empty-body and empty-result handling

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: What do the surfaces do with an empty/whitespace-only body, or a body that parses to zero blocks (e.g. frontmatter-only PUT)?
- **Why it matters**: `replace` with an empty body would wipe a document via what is most likely a caller bug (empty file, bad pipe).
- **Chosen default**: REST and `create_document`-with-markdown reject empty/whitespace-only input and frontmatter-only PUT bodies with 400; `fromMarkdown('')` returns an empty array (scripts compose; erroring there would be hostile).
- **Rationale**: Destructive-by-accident must be impossible; wiping a doc requires deliberately importing real content with `mode=replace`.

## 12. PUT response contract vs. feature 004

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
- **Question**: Design §2.4 gives the *sync* push response (new clock, canonical re-export, overlap flags). How much of that does M2's PUT return?
- **Why it matters**: Over-building M2's response duplicates 004; under-building forces a breaking change later.
- **Chosen default**: M2 returns document id, mode, new clock, block summary, and the itemized image report — no canonical re-export, no overlap flags. Response is a JSON object designed for additive extension.
- **Rationale**: New clock is cheap and already the sync primitive `list_documents` exposes; the rest is 004's contract and depends on machinery (source maps, baselines) M2 doesn't have.
