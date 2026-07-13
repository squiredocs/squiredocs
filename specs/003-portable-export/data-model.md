# Data Model — Portable Export (M3)

Phase 1 output. No database entities — this feature adds **no tables and no migrations**. The model
consists of document-schema nodes, registry declarations, and export-time value objects.

## 1. Schema nodes (shared/prosemirror-schema.js + client TipTap extensions)

### taskList

| Field | Value |
|-------|-------|
| content | `taskItem+` |
| group | `block` |
| parseDOM | `ul[data-type="taskList"]` |
| toDOM | `['ul', { 'data-type': 'taskList' }, 0]` |

Relationships: sibling of `bulletList`/`orderedList`; may appear anywhere block content is allowed,
including nested inside `listItem`/`taskItem` (mixed nesting per spec Edge Cases).

### taskItem

| Field | Value |
|-------|-------|
| attrs | `checked: { default: false }` (boolean) |
| content | `paragraph block*` (same as `listItem` — multi-paragraph + nested lists) |
| defining | true |
| parseDOM | `li[data-type="taskItem"]`, `getAttrs`: `data-checked === 'true'` |
| toDOM | `['li', { 'data-type': 'taskItem', 'data-checked': checked }, 0]` |

Validation: `checked` coerces to boolean; absent ⇒ `false` (FR-001).
Yjs representation: `Y.XmlElement('taskItem')` with string attribute `checked` = `'true' | 'false'`
(Yjs attrs are strings); structured serialization parses it back to a boolean alongside the existing
numeric attr parsing (`level`, `colspan`, `rowspan`).

State transitions: toggling `checked` is a single Yjs `setAttribute` — an editor-role edit,
attributed to its author like any edit (FR-002).

Block taxonomy registration (`server/mcp/yjs/block-types.js`): `taskList` → `LIST_CONTAINERS`;
`taskItem` → treated like `listItem` (inline-content-block membership mirrors `listItem`'s current
classification so plain-text/structured serialization inherit correct behavior).

## 2. Registry degradation declarations (format-registry.js)

Extension of existing `INLINE_MARKS` entries (unchanged entries omitted):

```js
{ name: 'underline', yjsAttr: 'underline', htmlTag: 'u',
  portable: { wrap: ['_', '_'],  collapsesWith: 'italic' } },
{ name: 'highlight', yjsAttr: 'highlight', htmlTag: 'mark',
  portable: { wrap: ['**', '**'], collapsesWith: 'bold' } },   // RD-2
```

Plus one registry-level declaration for the style mark:

```js
const TEXTSTYLE_PORTABLE = { drop: true };  // color/background/font/size/lineHeight → plain text
```

| Field | Meaning |
|-------|---------|
| `portable.wrap` | markdown delimiters used instead of the HTML tag in portable flavor |
| `portable.collapsesWith` | name of the native mark whose delimiters are identical; when both marks are present on a segment, exactly one delimiter pair is emitted (FR-012) |
| `portable.drop` (textStyle) | drop styling entirely, keep text |

Invariants:
- A mark with no `portable` property serializes identically in both flavors (bold, italic, strike,
  code, link, subscript, superscript — RD-10).
- Any use of a `portable`-declared mark in a portable export adds the mark's `name` (`textStyle` for
  style spans) to the export's **lossy set** (RD-6: actual degradations only).
- The round-trip suite iterates these declarations to generate portable-flavor cases (SC-006).

## 3. Export flavor (value object)

`flavor: 'squire' | 'portable'` — an option threaded through
`toMarkdown(fragment, { flavor, lossy })` / `toMarkdownNodes(nodes, { flavor, lossy })`.
Default `'squire'` everywhere (FR-009/FR-022); `format=bundle` surfaces default `'portable'` (RD-3).
Unknown value at the REST surface ⇒ 400.

## 4. Lossy set (value object)

`Set<string>` supplied by the export surface, populated by the serializer with the names of marks
actually degraded (`underline`, `highlight`, `textStyle`). Empty set ⇒ `lossy` key omitted from
frontmatter (FR-013). Not persisted anywhere.

## 5. Squire frontmatter block (file-level metadata)

Emitted by `buildFrontmatter(meta, foreignRaw)`; parsed by `parseFrontmatter(markdown)`.
Full contract: [contracts/frontmatter-squire-block.md](./contracts/frontmatter-squire-block.md).

| Key (under `squire:`) | Type | Presence | Source |
|------|------|----------|--------|
| `docGuid` | UUID string | always | document id |
| `title` | string | always | doc meta title |
| `clock` | integer | always | document version counter at export |
| `exportedAt` | ISO-8601 UTC string | always | export wall clock |
| `lastModifiedBy` | string (email/identity) | always | last modifier per documents layer |
| `flavor` | `squire` \| `portable` | always | effective export flavor |
| `lossy` | list of mark names | only when non-empty | lossy set (§4) |
| `images` | mapping `relativePath → imageId` | bundle exports only | bundle assembly (§7) |

## 6. Foreign frontmatter (preserved raw text)

`foreignRaw: string | null` — the raw YAML lines of a parsed frontmatter block minus the `squire:`
key's lines, byte- and order-preserved (RD-4). Produced by `parseFrontmatter`; carried by the caller
(002 import / 004 sync), never stored in the document schema; re-emitted verbatim ahead of the
regenerated `squire:` key on `frontmatter=true` export.

## 7. Export bundle (transient, per-request)

| Component | Value |
|-----------|-------|
| zip entry 1 | `<sanitizeFilename(title)>.md` — markdown with rewritten refs + frontmatter |
| zip entries 2…n | `assets/<docSlug>/<imageId>.<ext>` — one per resolvable referenced image, sorted by filename |
| docSlug | `slugifyDocTitle(title)`: NFKD, strip diacritics, lowercase, `[^a-z0-9]+`→`-`, trim, ≤60 chars, fallback `doc` |
| ext | from stored `mime_type`: png/jpg/gif/webp (`ALLOWED_IMAGE_MIME_TYPES`) |
| images map | `./assets/<docSlug>/<imageId>.<ext>` → `<imageId>`, sorted by path |

Determinism (RD-5/SC-004): filenames and references are pure functions of (title, imageId,
mime_type) — identical across exports of an unchanged document. Byte-identical zips are not promised
(entry timestamps); the contract documents structural determinism.

Graceful degradation (FR-021): unresolvable image (no DB row for (imageId, docId), storage disabled,
S3 fetch failure) ⇒ reference keeps its app URL; no asset entry; no images-map entry; export succeeds.

Nothing is persisted server-side (spec Assumption: no GC needed).

## 8. appendBlocks block shape (agent scripting API)

New accepted block type (FR-003), mirroring existing list shapes in
`server/mcp/sandbox/helpers.js` (`createBlock` dispatch, `createListItem`):

```js
{ type: 'taskList', items: TaskItemDef[] }

TaskItemDef :=
    "text"                                               // unchecked item
  | ["text", { text: "bold", attrs: {...} }]             // formatted, unchecked
  | { content: Content, checked?: boolean }              // explicit checked flag
  | { content: Content, checked?: boolean,
      items: ItemDef[], type?: 'taskList'|'bulletList'|'orderedList' }  // nested list
```

Validation errors (same style as existing types): missing/empty `items` ⇒
`appendBlocks: taskList items must be a non-empty array`; invalid item shapes reuse the existing
content-segment errors. `checked` defaults to `false`; non-boolean truthy/falsy values are coerced.
Nested `items` under a task item default to the parent type (`taskList`) unless `type` overrides.
