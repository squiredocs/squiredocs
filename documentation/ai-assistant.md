---
slug: ai-assistant
title: AI assistant
description: The built-in chat assistant in Squire Docs: chat modes, adding a selection to chat, image upload, inline diffs and undo, credits, and bringing your own key.
order: 7
---

Squire Docs has a built-in AI assistant in a chat panel on every page. The assistant can read, edit, and manage your documents through the same tools that external agents use, so its edits are attributed to it just like any other collaborator's. When a document is open, the assistant knows its title and can work on it directly.

## Chat panel and chat-centric mode

The chat panel docks on the right by default, with an adjustable width, or along the bottom with an adjustable height. On a phone it opens as a full-screen overlay that adapts to the on-screen keyboard. Your panel position and size are remembered per device.

There is also a full-page chat mode at `/chat`, with a sidebar of your past conversations and an optional document pane beside the chat. A button in the header switches between the document-centric layout and the chat-centric layout, and it keeps your context: the open document and the active conversation carry across the switch.

Conversations are saved. The history sidebar lets you search, rename, and switch between past chats, and the active chat is kept across page refreshes.

## Adding a selection to chat

Select text in a document and an "Add to Chat" tag appears. Click it to attach that passage to the chat input as a reference chip, labeled with the document it came from. You can then ask about the passage without describing where it is. This works on desktop and on touch devices, and you can stack several selections, including passages from different documents, before you send.

## Uploading images

You can attach up to five images to a chat message (PNG, JPEG, GIF, or WebP, up to 15 MB each) by dragging them in or using the file picker. Thumbnails preview before you send. The assistant can also place an image you attached into a document, and it can look at images and rendered SVG diagrams already in a document to answer questions about them.

## Importing markdown files

Drag a `.md` file into the chat (or attach it with the paperclip) and it is imported as a new document titled after the file name, up to 5 MB. The file's content goes directly to the markdown importer rather than into the conversation, so nothing is retyped or paraphrased on the way in — your message carries a link to the document that was created, and you can ask the assistant to work on it from there. See [Markdown export, import, and sync](/documentation/markdown) for the REST routes and two-way repository sync.

## Inline diffs and undo

When the assistant edits a document, its change shows in the chat message as a color-coded diff: additions in green, deletions in red. Large changes have expandable sections.

The most recent edit has an Undo button. Undo is a precise reversal of just that edit, so it keeps any edits made after it, unlike restoring an older version. After you undo, the diff is dimmed and marked "Reverted" as a record of what the assistant did, and the button becomes Redo.

## Credits

Each user has a monthly AI credit allowance, which defaults to 10 US dollars. Usage is measured per request from the token counts the AI provider reports, priced at official rates. When you use up your allowance, chat requests stop with a clear error banner, and the allowance resets at the start of each calendar month. An administrator can grant extra one-off credits that add to the monthly allowance.

## Bring your own key

You can supply your own API key for Anthropic, Google, OpenAI, z.ai, or OpenRouter on the Settings page. When you use your own key, chat requests run on that key and do not draw down the shared monthly credits. See [Account and support](/documentation/account-and-support).
