---
slug: markdown
title: Markdown export, import, and sync
description: Export Squire Docs documents as markdown, import markdown to create or update documents, and keep a two-way sync with your repository.
order: 10
---

Squire Docs documents move in and out as markdown. This page covers exporting, importing, and keeping a document in two-way sync with a file in a repository. The REST examples use an `sk_sqd_` API token; see [Agents and MCP](/documentation/agents-and-mcp) for how to create one.

## Exporting

Export any document you can view as a markdown (`.md`) file from the editor's tools menu, or over REST:

```
curl -H "Authorization: Bearer sk_sqd_..." \
  "https://squiredocs.com/api/docs/<docId>/export?format=markdown" -o doc.md
```

The export route takes options:

- **flavor**: `portable` (the default) or `squire`. Portable degrades the marks that only exist as HTML so the file renders cleanly on GitHub: underline becomes emphasis, and color and font spans drop their styling but keep their text. Squire flavor keeps full fidelity and is the internal canonical form.
- **frontmatter**: `true` or `false` (default off). When on, the file starts with a `squire:` YAML block that describes it, including its document id, title, and the version (`clock`) it was exported at.
- **format=bundle**: downloads a zip of the markdown plus its image assets under `assets/<docSlug>/`, with the references rewritten to relative paths. A bundle defaults to portable flavor with frontmatter on, and both are overridable.

For a repository-friendly export with the sync frontmatter, combine the options:

```
curl -H "Authorization: Bearer sk_sqd_..." \
  "https://squiredocs.com/api/docs/<docId>/export?flavor=portable&frontmatter=true" -o doc.md
```

## Importing

Import turns markdown into a document. There are three ways in over REST, all requiring the `documents:write` scope and accepting a `text/markdown` or `text/plain` body up to 5 MB.

Create a new document from markdown. The title comes from the frontmatter or the first heading, and the acting user owns it:

```
curl -H "Authorization: Bearer sk_sqd_..." \
  -H "Content-Type: text/markdown" \
  --data-binary @spec.md \
  "https://squiredocs.com/api/docs/import"
```

Import into an existing document with `mode=append` (the default) or `mode=replace`, which swaps the body in a single undoable step. This requires the editor role:

```
curl -X PUT -H "Authorization: Bearer sk_sqd_..." \
  -H "Content-Type: text/markdown" \
  --data-binary @spec.md \
  "https://squiredocs.com/api/docs/<docId>/import?mode=replace"
```

External image links in imported markdown are fetched and rehosted into the app's own image storage, so an imported document stays self-contained. When an image cannot be fetched, it degrades to a plain link, and the response itemizes what happened to each image.

## Two-way repository sync

A document exported with frontmatter can be edited in a repository, by a person or by tooling, and pushed back with `mode=sync`:

```
curl -X PUT -H "Authorization: Bearer sk_sqd_..." \
  -H "Content-Type: text/markdown" \
  --data-binary @doc.md \
  "https://squiredocs.com/api/docs/<docId>/import?mode=sync"
```

Rather than overwriting the document, a sync push replays the file's edits as native operations, anchored at the version the file was exported from. It behaves like a collaborator who went offline at that point, made edits, and reconnected. The baseline comes from the `clock` in the file's frontmatter.

Because the merge is operation-based, concurrent live edits merge in on their own. There are no conflict states to resolve. When a block was changed on both sides since the baseline, the push response flags it as an overlap for review afterward in version history, but it does not block the push. A push that changes nothing, or only reformats the markdown, is a true no-op: it stores no operations and creates no version.

A sync push returns the new version, a fresh canonical export of the document, and the overlap flags. The sync tool rewrites its local file from that export so the file is immediately ready as the next baseline. The version entry is attributed to the token's identity, shown as "Repo Sync (user)".
