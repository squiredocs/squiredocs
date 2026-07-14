---
slug: editing
title: Editing
description: Rich-text formatting, headings, lists and task lists, code, and links in the Squire Docs editor.
order: 3
---

The editor is a rich-text surface with a formatting toolbar. It is laid out like a word processor, with margins and a centered content area. This page covers the formatting you can apply.

## Text formatting

The toolbar has square buttons for bold, italic, underline, and strikethrough, shown as styled letters (B, I, U, S). You can also apply inline code, subscript, and superscript, and set text color, background color, font family, and font size.

Markdown typing shortcuts work as you type. For example, typing `**text**` produces bold text and `# ` at the start of a line produces a heading. These shortcuts come from the editor's defaults.

## Headings

Documents support three heading levels, H1 through H3. Use headings to structure a document into sections. Version history and search treat headings as structure, and the AI assistant can navigate by them.

## Lists and task lists

The editor supports bulleted lists, numbered lists, and task lists. Lists can nest.

Task lists are GFM-style checklists. Each item has a checkbox you can toggle. Toggling a checkbox is a real edit: it is collaborative and attributed to you, and it appears in version history like any other change. Task lists export to markdown as `- [ ]` and `- [x]`.

## Code

Insert inline code for short snippets inside a line, or a code block for multi-line code. Code blocks are plain text: they are not syntax-highlighted, and their content is not executed.

## Links

Add a link to selected text. When you export or import markdown, link targets are limited to safe protocols (`http`, `https`, `mailto`, and app-relative links); other targets keep their text but lose the link.

## Other blocks

The editor also supports blockquotes, horizontal rules, and tables. For images and diagram blocks, see [Images and diagrams](/documentation/images-and-diagrams).
