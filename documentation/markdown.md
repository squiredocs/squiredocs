---
slug: markdown
title: Markdown export, import, and sync
description: Export Squire Docs documents as markdown, import markdown to create or update documents, and keep a two-way sync with your repository.
order: 10
---

Squire Docs documents move in and out as markdown. This page covers exporting, importing, and keeping a document in two-way sync with a file in a repository. The REST examples use an `sk_sqd_` API token read from a file. Keep tokens in a file rather than typed into commands, since command-line arguments leak into shell history. See [Agents and MCP](/documentation/agents-and-mcp) for how to create one.

## Exporting

Export any document you can view as a markdown (`.md`) file from the editor's tools menu, or over REST:

```
curl -H "Authorization: Bearer $(cat ~/.squire/token)" \
  "https://squiredocs.com/api/docs/<docId>/export?format=markdown" -o doc.md
```

The export route takes options:

- **flavor**: `portable` (the default) or `squire`. Portable degrades the marks that only exist as HTML so the file renders cleanly on GitHub: underline becomes emphasis, and color and font spans drop their styling but keep their text. The `squire` flavor keeps full fidelity and is the internal canonical form.
- **frontmatter**: `true` or `false` (default off). When on, the file starts with a `squire:` YAML block that describes it, including its document id, title, and the version (`clock`) it was exported at.
- **format=bundle**: downloads a zip of the markdown plus its image assets under `assets/<docSlug>/`, with the references rewritten to relative paths. A bundle defaults to portable flavor with frontmatter on, and both are overridable.

For a repository-friendly export with the sync frontmatter, combine the options:

```
curl -H "Authorization: Bearer $(cat ~/.squire/token)" \
  "https://squiredocs.com/api/docs/<docId>/export?flavor=portable&frontmatter=true" -o doc.md
```

## Importing

Import turns markdown into a document. The quickest way in needs no terminal at all: drag a `.md` file into the assistant chat (or attach it with the paperclip) and the assistant imports it as a new document you own. The file's bytes go straight to the importer, never through the model, and the assistant replies with a link to the created document. See [AI assistant](/documentation/ai-assistant).

Over REST there are three ways in, all requiring the `documents:write` scope and accepting a `text/markdown` or `text/plain` body up to 5 MB.

Create a new document from markdown. The title comes from the frontmatter or the first heading (or a `?title=` override), and the acting user owns it:

```
curl -H "Authorization: Bearer $(cat ~/.squire/token)" \
  -H "Content-Type: text/markdown" \
  --data-binary @spec.md \
  "https://squiredocs.com/api/docs/import"
```

Import into an existing document with `mode=append` (the default) or `mode=replace`, which swaps the body in a single undoable step. This requires the editor role:

```
curl -X PUT -H "Authorization: Bearer $(cat ~/.squire/token)" \
  -H "Content-Type: text/markdown" \
  --data-binary @spec.md \
  "https://squiredocs.com/api/docs/<docId>/import?mode=replace"
```

External image links in imported markdown are fetched and rehosted into the app's own image storage, so an imported document stays self-contained. When an image cannot be fetched, it degrades to a plain link, and the response itemizes what happened to each image.

Every import response also carries a **receipt**: a canonical markdown export of the document as it now stands, alongside the new version (`clock`). Add `?frontmatter=true` to have the receipt include the sync frontmatter, and `?flavor=portable|squire` to pick its flavor. Writing the receipt back over your local file is what turns an import into a valid sync baseline (see below).

When an agent imports over this API, anyone watching the document sees the agent announce itself in presence and a brief highlight over what changed; see [Collaboration and sharing](/documentation/collaboration-and-sharing).

## Two-way repository sync

A document exported with frontmatter can be edited in a repository, by a person or by tooling, and pushed back with `mode=sync`:

```
curl -X PUT -H "Authorization: Bearer $(cat ~/.squire/token)" \
  -H "Content-Type: text/markdown" \
  --data-binary @doc.md \
  "https://squiredocs.com/api/docs/<docId>/import?mode=sync"
```

Rather than overwriting the document, a sync push replays the file's edits as native operations, anchored at the version the file was exported from. It behaves like a collaborator who went offline at that point, made edits, and reconnected. The baseline comes from the `clock` in the file's frontmatter, or from a `?baselineClock=` query parameter. Syncing a file for the first time? Do an initial import with `?frontmatter=true` and write the returned receipt back over the file; it is then a valid baseline. A push whose baseline is missing or invalid is rejected with an explanation rather than guessed at.

Because the merge is operation-based, concurrent live edits merge in on their own. There are no conflict states to resolve. When a block was changed on both sides since the baseline, the push response flags it as an overlap so you know to review the result in the version diff, but it does not block the push. A push that changes nothing, or only reformats the markdown, is a true no-op: it stores no operations and creates no version.

A sync push returns the new version, a fresh canonical export of the document, and the overlap flags. Write that export back over your local file and it is immediately ready as the next baseline; you or your tooling drive the loop with these two REST calls. Agents connected over MCP get a ready-made recipe for the whole loop from the `import_markdown_file` tool, and the full REST reference via `get_tool_documentation({ tool: "rest_api" })`.

The version entry for a sync push is attributed as "Repo Sync (user)", a fixed name, so history reads consistently no matter which token pushed. A push can also carry `X-Squire-On-Behalf-Of-*` headers naming the commit author, commit, and URL it came from, which version history displays. This is what makes a CI-driven sync legible in history.
