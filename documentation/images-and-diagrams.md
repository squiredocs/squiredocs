---
slug: images-and-diagrams
title: Images and diagrams
description: Insert images, add Mermaid and SVG diagram blocks, and copy and paste them in Squire Docs.
order: 4
---

Documents can hold images and two kinds of diagram block. This page covers inserting them and how copy and paste behaves.

## Images

Insert an image with the toolbar picker (the image button), by dragging a file in, or by pasting, for example a screenshot from your clipboard. Supported formats are PNG, JPEG, GIF, and WebP, up to 15 MB per image.

The image bytes are stored in a dedicated storage bucket. The document itself holds only a short app link to the image, which keeps the document's edit history small. When you view a document, the app exchanges that link for a short-lived, signed link to the stored file.

Image upload requires the server to be configured with image storage. If storage is not configured, uploads are refused.

Images export to markdown as `![alt](url)`; the alt text is the uploaded file's name. In a plain markdown export the URL is an app link that needs a signed-in session or token to resolve. For a self-contained file, use the bundle export, which packages the images and rewrites the links to relative paths (see [Markdown](/documentation/markdown)).

You can also attach images to the AI assistant chat and ask it to place them in a document; see [AI assistant](/documentation/ai-assistant).

## Diagram blocks

The toolbar has two diagram blocks:

- A Mermaid block for diagrams written as Mermaid code.
- An SVG block for raw SVG markup.

While your cursor is inside a block you see the source; the rendered diagram appears a moment after you click out or press Done. Each block has an Edit/Done toggle, an expand-to-fullscreen button, and a download menu for saving the diagram as SVG or PNG. SVG markup is sanitized when it renders: scripts, event handlers, `foreignObject`, and references to external resources are removed, so diagram markup written by a collaborator or an agent cannot run script or load outside content.

Diagram blocks export to markdown as fenced code blocks (` ```mermaid ` and ` ```svg `), which lets external agents read and edit them and lets GitHub render Mermaid natively.

## Copying and pasting diagrams

Copying a diagram places a rasterized PNG of it on your clipboard, so it pastes into other tools such as Google Docs or Notion as an image. The diagram's source travels along with the copy, so pasting back into Squire Docs reconstructs an editable diagram block rather than a flat image. (Some tools strip the embedded source on the way through; a very large diagram pasted back through one of them arrives as an image with a note that the source was not preserved.)
