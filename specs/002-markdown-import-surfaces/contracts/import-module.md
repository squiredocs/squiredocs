# Contract: Import Module & Sandbox Helper

## `importMarkdown(ydoc, markdown, options)` — `server/markdown-import.js`

The single code path for every import surface (FR-001). No surface may parse or materialize on its own.

### Signature

```js
/**
 * @param {Y.Doc} ydoc - live shared doc (from documentService.getSharedDoc or createSeededDocument flow)
 * @param {string} markdown - untrusted markdown text (already size-capped by the surface)
 * @param {object} options
 * @param {'append'|'replace'|'insertAfterXPath'} options.mode
 * @param {string} [options.insertAfterXPath] - structural XPath, required iff mode==='insertAfterXPath'
 * @param {{ userId: string, agentName?: string|null }} options.actor - attribution origin
 * @param {{ docId: string }} options.imageContext - target doc for the rehost pass
 * @returns {Promise<{ blocks: { imported: number }, images: ImageReport, frontmatter: { title?: string } }>}
 */
async function importMarkdown(ydoc, markdown, options)
```

### Behavior

1. **Normalize**: strip BOM; normalize CRLF → LF.
2. **Frontmatter** (before parsing): detect leading `---` YAML block at absolute start. Extract `squire:` keys (this feature reads `title` only); re-emit non-`squire:` keys as a leading fenced `yaml` code block in the body; malformed YAML ⇒ whole block is ordinary content. Never throws on frontmatter (FR-006/007).
3. **Parse**: `markdownToPm(body)` — feature 001's tolerant mode, exclusively (FR-003). The module never interprets markdown itself.
4. **Link sanitation** (FR-022): walk the PM JSON; link marks whose href protocol is not `http`/`https`/`mailto`/app-relative are dropped (text kept). Case-insensitive scheme match after trimming control/whitespace chars (`javascript:`, `data:`, `vbscript:`, `file:` all die here).
5. **`data:` image rejection** (FR-019): image nodes with `data:` src become their alt text (plain text; dropped when alt empty), itemized in report.
6. **Materialize + mutate**: convert PM JSON to Yjs nodes (research R1: y-prosemirror seam) and apply per mode inside **one** `documentService.updateDocument(docGuid, fn, { userId, agentName })` transaction:
   - `append`: insert at fragment end.
   - `replace`: delete existing top-level blocks + insert new ones, same transaction, same fragment (never recreate the fragment/doc).
   - `insertAfterXPath`: resolve XPath first; **no match ⇒ throw before any mutation**; otherwise insert immediately after the match.
7. **Empty result guard** (FR-005/CN-11): a body that yields zero blocks after frontmatter stripping ⇒ error (surfaces map to 400). Guard runs before mutation, so `replace`-to-empty is impossible.
8. **Image rehost pass** (after materialization, before returning): see `image-rehost.md`. External `http(s)` srcs fetched-and-rehosted or degraded to plain links; cross-doc app URLs via existing `reconcileCrossDocImages`; same-doc app URLs untouched (FR-016/018/020).
9. **Report**: return blocks summary + ImageReport + derived frontmatter fields (title for the create surfaces).

### Invariants

- Never-lose-content inherited from the parser (FR-003); the only exceptions are the `data:` payload (CN-6) and dropped link marks (text always kept).
- One transaction ⇒ one undo boundary ⇒ one attributed version entry (FR-004). No privileged write path.
- The stored document contains zero external and zero `data:` image srcs after import (SC-003).
- Error before mutation ⇒ document unchanged (no partial import).

## `fromMarkdown(md)` — sandbox global (modify scripts)

Same contract as `cloneBlocks` output (FR-009):

```ts
declare function fromMarkdown(md: string): Y.XmlElement[]  // detached, tracked nodes
```

- **Synchronous**; no network, no async, never throws on unstructurable content — worst case returns literal-text paragraph nodes; `fromMarkdown('')` (or whitespace-only) returns `[]` (FR-005, CN-11).
- Built with the sandbox's **tracked constructors** (`WrappedXmlElement`/`WrappedXmlText`) so insertions stream live like any other script mutation.
- Runs the same parse → link-sanitation → `data:`-rejection pipeline as the module (steps 1–5 above; frontmatter in a fragment context is treated as ordinary content — no title semantics inside modify).
- External image srcs survive into the returned nodes but are **tagged** for the host-side post-script pass, which rehosts them (import-origin) instead of stripping (FR-021, research R3). `data:` srcs never survive into nodes.
- Implementation seam: a shared `pmJsonToNodes(pmJson, { XmlElement, XmlText })` helper (options pattern identical to `helpers.cloneNodes`) used by both the module and the sandbox entry; grammar knowledge stays in the parser/registry (Principle IV).
- Requires the sandbox bundle rebuild: `npm run build:sandbox-bundle`.

## `create_document` tool extension

- `inputSchema`: `title` becomes optional; new optional `markdown` (string). At least one of `title`/`markdown` required (validation error otherwise).
- With `markdown`: seed the doc with imported content **instead of** the empty anchor paragraph (real content preserves the presence-cursor anchor the empty paragraph existed for); title precedence per FR-008; heading used for title stays in the body.
- Return shape extends the existing `{ docGuid, title, url, message }` with `blocks` and `images` when `markdown` present.
- Scope: `documents:write` (already enforced by the tool registry `TOOL_SCOPES`).
