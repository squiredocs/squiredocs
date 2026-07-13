# Contract: Bundle Zip Layout (`format=bundle`)

**Surface**: `GET /api/docs/:docId/export?format=bundle` (see [export-api.md](./export-api.md) for
the full query contract). **Consumers**: end users (unzip → renders anywhere), feature 002 (imports
`.md` + images-map resolution), M5 `squire-sync` tooling.

## Response

- `200` with `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="<sanitizeFilename(title)>.zip"` (RFC 5987 fallback for
  non-ASCII, same mechanism as the existing markdown export)
- Body: streamed zip archive.

## Archive layout

```text
<sanitizeFilename(title)>.md          # the markdown file (first entry)
assets/<docSlug>/<imageId1>.<ext>     # one entry per resolvable referenced image,
assets/<docSlug>/<imageId2>.<ext>     #   sorted by filename
```

- **docSlug** = `slugifyDocTitle(title)`: NFKD-normalize, strip diacritics, lowercase, replace
  `[^a-z0-9]+` runs with `-`, trim leading/trailing `-`, cap 60 chars, fallback `"doc"` for
  empty/fully-non-ASCII titles. Derivation never fails an export (spec Edge Cases).
- **Asset filename** = `<imageId>.<ext>` (RD-5), `imageId` the image's UUID, `ext` from stored MIME:
  `image/png`→`png`, `image/jpeg`→`jpg`, `image/gif`→`gif`, `image/webp`→`webp`.
- A document with no images ⇒ a valid zip containing only the `.md` (FR-017, spec US4-AS3).

## Reference rewriting

Every in-body image reference whose src matches this document's app-URL shape
`/api/docs/<docId>/images/<imageId>` (this `docId` only) and whose image resolves is rewritten to:

```markdown
![alt](./assets/<docSlug>/<imageId>.<ext>)
```

- Duplicate references to one image ⇒ one asset entry, one images-map entry, all references rewritten.
- References to other documents' images, non-app URLs, or unresolvable images are left untouched and
  excluded from assets and the map.

## Frontmatter `images` map

The bundle's markdown carries frontmatter (default on, RD-3) whose `squire.images` mapping has
exactly one entry per rewritten reference:

```yaml
images:
  ./assets/<docSlug>/<imageId>.<ext>: <imageId>
```

Keys are the exact relative paths appearing in the body; values are image ids; sorted by key.
This is the reverse index 002/004 use to resolve relative refs back to Squire images.

## Graceful degradation (FR-021)

Per image, any of: no `document_images` row for `(imageId, docId)`, image storage disabled
(`s3Images.isEnabled() === false`), S3 object fetch failure ⇒ that image is skipped: its body
reference keeps the original app URL, it gets no asset entry and no map entry. The export still
returns 200 with everything else intact. Export never fails wholesale over one lost image; a
storage-disabled deployment yields a valid bundle with zero assets.

## Determinism (RD-5 / SC-004)

Asset filenames, rewritten references, the images map, and entry ordering (markdown first, assets
sorted by filename) are pure functions of the document state — two exports of an unchanged document
are structurally identical. **Not promised**: byte-identical zip files (entry timestamps) or a
byte-identical `.md` (`exportedAt` in frontmatter). Repo-diff quietness comes from stable names and
references, plus 004 stripping the `squire:` block before diffing.

## Auth & scope (FR-017, Constitution V)

Identical to the existing export route: `requireAuth` (browser session or `sk_sqd_` token with
`documents:read`), then document view-access check (`documents.getRole`); failure modes and status
codes match the markdown export exactly. Assets are doc-scoped by construction
(`getImage(imageId, docId)`). No new scopes, no new ACL semantics.
