<!-- source: https://squiredocs.com/d/9bb17cdc-0b56-4c87-8b4e-d3686029cb8a
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Media and Diagram Blocks

## What this is

The two rich-content systems: S3-backed images with app-URL indirection, and live-rendering Mermaid/SVG diagram blocks with a strict shared sanitization policy. Both are designed around the same threat model — collaborator- and agent-authored content is untrusted.

## Images

- **Documents never hold bytes. **An image node’s src is an app URL (`/api/docs/:docId/images/:imageId`); bytes live in a dedicated S3 bucket (key `doc-images/<docId>/<imageId>`, immutable cache headers), metadata in `document_images`. This keeps the Yjs update log small and makes access control enforceable per view.
- **Resolution: **the client exchanges the app URL (authenticated, access-checked) for a 1-hour presigned S3 GET; the browser loads from S3 directly. CSP img-src allowlists the bucket host.
- **Upload: **toolbar/drag/paste (editor-role required) and the assistant’s insert_image. Policy in `server/document-images.js`: PNG/JPEG/GIF/WebP only — SVG deliberately excluded as a script vector — 15 MB cap.
- **Agent guardrail: **`isAllowedImageSrc` strips any agent-written image whose src is not the app form (no external or data: URLs — a tracking/exfiltration vector); cross-document clones are re-hosted into the target doc when the user can read the source, stripped otherwise.
- **Lifecycle: **doc deletion best-effort-deletes S3 objects and cascades the rows; images removed from a living doc are not yet garbage-collected.

## Diagram blocks

- **One factory, two nodes: **`client/src/extensions/diagramBlock.js` builds both MermaidNode (lazy-loaded mermaid, securityLevel strict, no htmlLabels — so rasterization never taints the canvas) and SvgNode (source is the SVG; rendering = sanitize).
- **Sanitization is one shared policy: **`shared/svg-sanitizer.mjs` (used by the client node view AND the server’s validation worker) — DOMPurify SVG profile, forbids foreignObject/style/script/media, URI attributes restricted to same-doc fragments and data:image, external url(…) rewritten to none, fail-closed when nothing renderable survives. Callers pass an isolated DOMPurify instance so mermaid’s internal copy can’t be polluted.
- **Clipboard: **copying a diagram puts a pre-rasterized PNG (≤1 MB, ≤2000px) on the clipboard so it pastes into Google Docs/Notion as an image, with the source URI-encoded into the alt text (capped 1000 chars) — pasting back into Squire reconstructs an editable block from that channel.
- **Server side: **diagrams render only in the browser, so the modify pipeline validates them in a jsdom worker thread (isolated because global jsdom breaks google-auth), and `view_svg_blocks` rasterizes via @resvg/resvg-js (no browser, no network; DejaVu fonts baked into the image) for assistant vision.