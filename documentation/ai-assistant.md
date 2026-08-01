---
slug: ai-assistant
title: AI assistant
description: The built-in chat assistant in Squire Docs: chat modes, adding a selection to chat, image upload, inline diffs and undo, credits, and bringing your own key.
order: 7
---

Squire Docs has a built-in AI assistant in a chat panel on every page. The assistant can read, edit, and manage your documents through the same tools that external agents use, so its edits are attributed to it just like any other collaborator's. When a document is open, the assistant knows its title and can work on it directly. It can also search the web and read pages you link, citing its sources in the reply.

## Chat panel and chat-centric mode

The chat panel docks on the right by default, with an adjustable width, or along the bottom with an adjustable height. On a phone it opens as a full-screen overlay that adapts to the on-screen keyboard. Your panel position and size are remembered per device.

There is also a full-page chat mode at `/chat`, with a sidebar of your past conversations and an optional document pane beside the chat. A button in the header switches between the document-centric layout and the chat-centric layout, and it keeps your context: the open document and the active conversation carry across the switch.

Conversations are saved. The history sidebar lets you search, rename, and switch between past chats, and the active chat is kept across page refreshes. A reply keeps streaming even if you navigate elsewhere in the app, and a Stop button interrupts it if it is heading the wrong way. While the assistant reasons through a harder request, a "Thinking" block shows a live summary of what it is working through. Very long conversations are condensed automatically in the background so the chat can continue without losing the thread.

## Adding a selection to chat

Select text in a document and an "Add to Chat" tag appears. Click it to attach that passage to the chat input as a reference chip, labeled with the document it came from. You can then ask about the passage without describing where it is. This works on desktop and on touch devices, and you can stack several selections, including passages from different documents, before you send.

## Uploading images

You can attach images to a chat message (PNG, JPEG, GIF, or WebP, up to 15 MB each) by dragging them in, pasting, or using the file picker, up to five attachments per message (images and markdown files combined). Oversized images are scaled down in the browser before upload. Thumbnails preview before you send. The assistant can place an image you attached into a document, and it can look at images and rendered SVG diagrams already in a document to answer questions about them.

Whether the assistant can see images depends on the model: models from Anthropic, Gemini, and OpenAI can, while some others are text-only. If the current model cannot read images, attaching one is refused with a clear message.

## Importing markdown files

Drag a `.md` file into the chat (or attach it with the paperclip, up to 5 MB) and send it like any attachment. The assistant imports it as a new document titled after the file name and replies with a link. The file's content moves directly from the attachment into the markdown importer rather than through the conversation, so nothing is retyped or paraphrased on the way in. The import appears in the chat as a tool call, attributed like any assistant edit. See [Markdown export, import, and sync](/documentation/markdown) for the REST routes and two-way repository sync.

## Inline diffs and undo

When the assistant edits a document, its change shows in the chat message as a color-coded diff: additions in green, deletions in red, with the changed words inside a line given a stronger highlight. Large changes have expandable sections.

The most recent edit has an Undo button. Undo is a precise reversal of just that edit, so it keeps any edits made after it, unlike restoring an older version. After you undo, the diff is dimmed and marked "Reverted" as a record of what the assistant did, and the button becomes Redo. Undo and redo show the same rich diff, so you can see exactly what came back.

## Credits

Each user has a monthly AI credit allowance, which defaults to 10 US dollars. Usage is measured per request from the token counts the AI provider reports, priced at official rates. The Settings page shows a usage meter with what you have used, your limit, and the date your allowance resets (the start of each calendar month). An administrator can grant extra one-off credits that add to the monthly allowance.

When something goes wrong (your allowance runs out, the provider is busy, a key is rejected), chat stops with a banner that says what happened and what to do about it, with a Retry button when retrying can actually help. If a reply is cut off, the partial reply is kept and marked as interrupted. These notices are saved with the conversation, so they are still there after a reload.

## Bring your own key

You can supply your own API key for Anthropic, Gemini, OpenAI, z.ai, or OpenRouter on the Settings page, turn on "Use my key", and pick the model to run on. Chat requests then run on your key with your chosen model (the panel header shows which) and do not draw down the shared monthly credits. See [Account and support](/documentation/account-and-support) for the setup steps.
