# Phase 0 Research: Markdown Import Surfaces

All open questions raised by the Technical Context are resolved below. Product-level unknowns were pre-settled as RATIFIED-BY-DEFAULT in [`clarifications-needed.md`](./clarifications-needed.md) (CN-1…CN-12) and are not re-litigated here; this file records the *technical* decisions the plan depends on, grounded in the real code.

---

## R1 — PM-JSON → Yjs materialization strategy

**Decision**: Materialize `markdownToPm` output into the live `'default'` `Y.XmlFragment` using `y-prosemirror`'s ProseMirror-JSON → Y conversion (`prosemirrorJSONToYDoc` / `prosemirrorToYXmlFragment`), driven by the shared `prosemirror-schema.js`, then move/insert the resulting block nodes into the target fragment. Wrap all writes in one `documentService.updateDocument` transaction.

**Rationale**: `markdownToPm` returns ProseMirror JSON (confirmed: nodes shaped `{ type, attrs, content, marks }`, e.g. `{ type: 'codeBlock', attrs:{language}, content:[{type:'text',text,marks}] }`). `y-prosemirror` is already a dependency (`package.json` `"y-prosemirror": "^1.2.0"`; used by `diff-service.js` via `yXmlFragmentToProseMirrorRootNode`, and by `html-serialization.js`). It is the exact, schema-aware inverse of the serializer the design calls for ("the inverse of `toMarkdownNodes`") and guarantees schema-valid Yjs output. Building a bespoke PM-JSON walker would duplicate `node-builder.js`/`y-prosemirror` and risk drift (Principle IV single-source).

**Alternatives considered**:
- **Extend `server/mcp/yjs/node-builder.js`** (`buildYjsNode`): its input shape is the *structured* block JSON (`{type, content, children, level, language}`), **not** ProseMirror JSON — it lacks marks-on-text-run fidelity and nested-mark handling. Rejected as the primary path (would need a PM-JSON→structured adaptor that re-encodes mark logic). May still be used internally where convenient, but the mark-preserving path is `y-prosemirror`.
- **Bespoke recursive builder in `markdown-import.js`**: rejected — reinvents schema-aware conversion, more surface for round-trip bugs.

**Constructor-injection reconciliation** (how this coexists with the sandbox's tracked constructors): `y-prosemirror` builds nodes with plain `Y.*` constructors and cannot take injected ones. The seam therefore works in two steps: (1) materialize PM JSON into a **scratch `Y.Doc`** via `y-prosemirror`; (2) produce detached, constructor-injectable nodes by running the existing `helpers.cloneNodes(scratchFragment, { XmlElement, XmlText })` over the result. On the server path the injected constructors are the plain `Y.*` ones; in the sandbox they are the tracked wrappers — which is exactly why FR-009 phrases the contract as "same contract as `cloneBlocks` output". This also sidesteps the Yjs restriction that nodes attached to one doc cannot be inserted into another.

**Note for tasks**: verify the `y-prosemirror` conversion preserves every registry mark and the diagram/table/image nodes by asserting round-trip (SC-007) early; if a specific node needs coaxing, fix it at the conversion seam, not with a parallel serializer.

---

## R2 — `fromMarkdown` sandbox helper: synchronous, no network

**Decision**: Expose `globalThis.fromMarkdown(md)` in `isolate-entry.js`, built on the *tracked* wrapped constructors (`WrappedXmlElement`/`WrappedXmlText`), returning an array of detached Yjs nodes with the **same contract as `cloneBlocks`**. It converts `markdownToPm(md)` output to nodes using a shared `pmJsonToNodes(json, { XmlElement, XmlText })` helper (same options pattern as `helpers.cloneNodes` and `helpers.appendBlocks`). It is **synchronous** and does **no image fetching** inside the sandbox.

**Rationale**: The sandbox is an isolated-vm isolate with no Node APIs and no network (`design/agent-surface-mcp.md`: "no Node APIs"). Image rehosting is a server-side, async, network operation — it cannot run inside the isolate. So `fromMarkdown` produces nodes that may still carry external/`data:` image srcs; those are reconciled **after** the script runs, on the host side, by the same post-script image pass `modify.js` already runs (`sanitizeImageSrcs` + `reconcileCrossDocImages`) — extended so import-originated external srcs are *rehosted* rather than *stripped* (FR-021 scope: import surfaces only). See R3.

**Alternatives considered**: making `fromMarkdown` async and fetching inside the sandbox — impossible (no network in isolate) and would violate the sandbox trust model. Rejected.

**Bundle impact**: `isolate-entry.js` changes ⇒ rebuild `isolate-bundle.js` via `npm run build:sandbox-bundle`. `markdownToPm` must already be client-safe/Node-free per feature 001 (FR-014) so it bundles into the isolate cleanly — this is a hard dependency on 001 landing first.

---

## R3 — Where image rehosting runs for each surface (the FR-021 seam)

**Decision**: Rehosting is a **host-side, post-materialization** pass keyed to import-originated nodes, never inside the sandbox:
- **REST + `create_document`**: `importMarkdown` materializes nodes into the target fragment, then the host calls `image-rehost.rehostImagesInFragment(fragment, { docId, userId, budget })` over the just-inserted image nodes.
- **`fromMarkdown` in modify**: the helper returns nodes into the live doc during the script; after the script, `modify.js`'s existing image pass runs. That pass is **extended** so that external `http(s)` srcs *that arrived via import* are fetch-and-rehosted; directly-authored external srcs (e.g. an `appendBlocks` image) keep today's **strip** behavior (FR-021, CN-8).

**Rationale**: This keeps one rehost implementation and reuses the existing cross-doc reconciliation (`reconcileCrossDocImages` in `image-validate.js`) unchanged for app-URL images (FR-020). The tricky part — distinguishing "import-originated external src" from "script-authored external src" inside modify — is handled by tagging: `fromMarkdown` marks its externally-sourced image nodes (e.g. a transient attribute like `data-import-src` consumed and removed by the rehost pass) so the post-script pass knows which externals to rehost vs strip. Simpler surfaces (REST/create) have no ambiguity — every image came from the import.

**Alternatives considered**:
- Rehost synchronously as part of materialization for REST/create but require modify to strip — inconsistent UX and splits the policy. Rejected in favor of one rehost module with a tagging seam.
- Rehost *all* external srcs in modify (drop the import-only distinction) — explicitly rejected by CN-8 (blast-radius / design scope). Kept import-only.

---

## R4 — SSRF-safe fetch implementation (zero new deps)

**Decision**: Implement the fetch in `server/image-rehost.js` on Node core (`dns.lookup`, `net`/`http`/`https`, or `undici`/global `fetch` with a custom `lookup`/agent). Policy (CN-7): `http`/`https` only; resolve the hostname, **validate every candidate IP** against the blocklist, and **pin the connection to the validated IP** (pass the resolved address so the socket connects to exactly the IP that was checked — closes the DNS-rebind TOCTOU window); re-validate on **every redirect hop** (max 3); 10 s per-fetch timeout; enforce the **existing 15 MB image cap while streaming** (abort as soon as the byte count exceeds it); check declared `Content-Type` against the **existing png/jpeg/gif/webp allowlist**; ≤ 20 unique URLs per import, deduplicated.

**Blocked ranges** (validated per hop): RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`, `::1`), link-local (`169.254/16` incl. `169.254.169.254` cloud metadata, `fe80::/10`), unique-local (`fc00::/7`), unspecified (`0.0.0.0`, `::`), multicast, and IPv4-mapped IPv6 forms of the above. Reject non-global addresses.

**Rationale**: The design/constitution require zero new markdown/serialization deps and a minimal dependency posture; Node core covers DNS resolution + connection pinning. `undici` (bundled with Node 22) exposes a `Dispatcher`/`connect` hook that lets us pin to a pre-validated IP cleanly; either that or a manual `http.request` with `lookup` is acceptable — the contract (`contracts/image-rehost.md`) fixes the *behavior*, not the library call. No third-party SSRF library is introduced.

**Alternatives considered**: a third-party SSRF-guard npm package — rejected (new dependency, and the policy is small enough to own and test directly, which also makes SC-004's address-family test suite the source of truth).

---

## R5 — Storing rehosted bytes: reuse `document-images.storeImage`

**Decision**: Rehosted bytes go through `documentImages.storeImage({ docId, uploaderId: userId, data, mimeType, filename })` unchanged. It already validates MIME + 15 MB cap, writes S3 then the metadata row, and returns `{ id, url }` (an app image URL). The image node's `src` is rewritten to that URL. When `s3Images.isEnabled()` is false, rehosting is impossible → degrade all externals to plain links (parity with `reconcileCrossDocImages`'s no-op-when-disabled posture).

**Rationale**: Reuses the exact storage path `insert_image` and cross-doc copy use — attribution, cap, MIME allowlist, and S3 key scheme all inherited, no parallel storage logic (Principle IV). `storeImage`'s own cap is a second line of defense behind the streaming cap in R4.

---

## R6 — Auth/scope/role enforcement is mostly already present

**Decision**: Mount both routes with the existing `requireAuth` (`server/auth/middleware.js`). It already: (a) accepts browser sessions **and** `sk_sqd_`/agent tokens via `extractUser`, and (b) **enforces `documents:write` on all non-GET methods** for scoped principals (`checkScopes` → `requiredScopeForMethod`) — so PUT/POST automatically require `documents:write`, returning the standard `403 {code:"INSUFFICIENT_SCOPE"}`. The **genuinely new** enforcement is:
- **PUT**: editor role on the target doc — `documents.getRole(docId, userId)` / `hasRole(docId, userId, 'editor')` (owner qualifies), 403 otherwise; missing doc / no role → 403 like export.
- **POST**: no doc exists yet; the acting user becomes owner via `createSeededDocument` (already sets owner role).

**Rationale**: This refines CN-10 further: not only is `documents:write` not a new *scope*, its REST enforcement for mutating methods **already exists** in `requireAuth`. The feature's real auth work is the **editor-role check on PUT** plus wiring, not scope plumbing. (This does not reopen CN-10; it strengthens its conclusion. Noted for the analyze pass and the doc-amendment flag.)

**Alternatives considered**: a bespoke scope middleware on the import router — rejected (duplicates `checkScopes`; `requireAuth` is the export route's model the spec says to follow, FR-011).

---

## R7 — No database migration required

**Decision**: **No node-pg-migrate migration.** Rehosted images reuse the existing `document_images` table via `storeImage` (no new columns); the import report is computed in-memory and returned in the HTTP/tool response (not persisted); document body writes go through the existing Yjs update log. Nothing in this feature adds or alters schema.

**Rationale**: Confirmed by reading `document-images.js` (INSERT into existing `document_images` columns only) and the response contract (CN-12: report is a transient JSON object). **Flagged per orchestrator instruction**: migration ordering is globally coordinated; this feature intentionally adds none. If implementation later discovers a genuine need (it should not), it must be raised to the orchestrator before adding a migration.

---

## R8 — Frontmatter parsing without a YAML dependency risk

**Decision**: Detect a leading fenced YAML frontmatter block (`---\n … \n---` at absolute document start, after BOM/CRLF normalization) in `markdown-import` **before** handing the remaining body to `markdownToPm`. Parse only enough to (a) find a `squire:` mapping and read its recognized `title` field, and (b) partition `squire:` vs non-`squire:` keys. Recognized-field extraction uses a minimal, defensive YAML read; **any** parse failure ⇒ treat the whole block as ordinary markdown content (never fail the import — FR-007). Non-`squire:` keys are re-emitted as a leading fenced ` ```yaml ` code block (CN-5) so nothing is lost; a block that is *only* `squire:` keys leaves no residue.

**Rationale**: Feature 001 explicitly does **not** handle frontmatter (001 spec Edge Cases: "M1 has no frontmatter awareness … Frontmatter semantics belong to features 002/003"). So 002 owns detection/stripping. Malformed-YAML-as-content and defensive consumption are mandated (FR-006/FR-007, CN-5). A full YAML library may be used if already present; if introducing one is required, it is a *parsing-support* dep for frontmatter only (not markdown/serialization) and must be justified at implementation — but a minimal hand-rolled key scan for the `squire:` block is sufficient and preferred (avoids a new dep entirely). **Open sub-decision left to implementer**, bounded by: no import may ever fail on frontmatter shape.

**Alternatives considered**: parsing frontmatter inside `markdownToPm` — rejected (001 owns the parser and declared frontmatter out of scope; keeping it in 002 respects the layering and the never-fail rule).

---

## R9 — `insertAfterXPath` module capability, not a REST mode

**Decision**: `importMarkdown` supports `mode: 'insertAfterXPath'` with an `insertAfterXPath` query string; it locates the first matching element via the sandbox/xpath engine (`server/mcp/sandbox/xpath.js`), inserts the parsed blocks immediately after it, and **errors without mutating** when there is no match (FR-002, edge case). It is used by `fromMarkdown`-style composition and future callers but is **not** a REST `mode` value — REST validates `mode ∈ {append, replace}` and rejects anything else as 400 (FR-015, CN-3 default `append`).

**Rationale**: Ground truth (design §1.2) lists three module modes but REST body says only `mode=append|replace`. XPath (never positional) satisfies Principle IV. Erroring-without-mutation preserves the no-partial-import invariant.

---

## Consolidated dependency & risk notes

- **Hard dependency on feature 001**: `markdownToPm` must be tolerant-mode default, never-lose-content, HTML-whitelisted, and **Node-free/client-safe** (so it bundles into the isolate for `fromMarkdown`). If 001 has not merged, 002 is blocked (spec §Depends on).
- **Sandbox bundle rebuild** is a required build step whenever `isolate-entry.js` or `helpers.js` change; forgetting it ships stale sandbox behavior (MEMORY: mutagen/stale-code hazard).
- **Round-trip (SC-007/FR-023)** is the earliest high-value integration test — it exercises parser→materialize fidelity end-to-end and guards against silent structure loss.
- **No new rate limiter** (spec Assumptions): the per-import fetch budget (≤20, dedup, 10s, 3 redirects) is the only new abuse bound.
