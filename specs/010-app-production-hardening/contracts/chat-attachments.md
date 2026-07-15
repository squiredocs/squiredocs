# Contract: Chat Body Bound & Attachment Upload

## `/api/chat` inline JSON body limit (FR-017, RD-6)

- Limit shrinks from **150MB → `CHAT_BODY_LIMIT`** (default `10mb`, env-overridable).
- A body over the limit (including a legacy inline-base64 body) is rejected **413** before it is
  buffered past the limit, with an actionable message pointing at the attachment path:

```
HTTP/1.1 413 Payload Too Large
Content-Type: application/json

{ "error": "Request body too large. Upload attachments via POST /api/chat/attachments and send references instead of inline image data." }
```

- A realistic text-only conversation stays well under 10MB and is accepted (FR-017 scenario 3, SC-009).

## `POST /api/chat/attachments`  (new, `requireAuth`)

Uploads one attachment's bytes to S3 so the chat body carries a reference, not base64.

**Request** (multipart or JSON base64 — implementation choice; mirrors `document-images` validation):
- authenticated user (cookie/Bearer via `requireAuth`)
- one image file; mime allow-list + per-file size limit mirror `document-images.storeImage`

**Responses**

| Situation | Status | Body |
|-----------|--------|------|
| stored | 201 | `{ "reference": "<handle>", "mediaType": "image/png", "filename": "…" }` |
| S3 not configured | 503 | `{ "error": "Image storage is not configured" }` |
| invalid type / too large | 400 / 413 | `{ "error": "<reason>" }` |
| unauthenticated | 401 | (from `requireAuth`) |

- Bytes stored at `chat-attachments/<userId>/<uuid>` — ownership encoded in the key.
- Rate-limit-eligible under the per-user `chat` class budget policy is **not** required here; the
  chat send itself is the metered surface. (If abuse is later observed, an upload budget can be
  added — env-configurable.)

## Reference resolution (FR-016, FR-018)

When assembling the model request in `chat.js`:
- A message file part carrying an attachment **reference** is resolved by fetching bytes via
  `s3-images.getObject(key)` **only if** the key's `<userId>` segment equals `req.user.userId`
  (user-scope enforcement — a user can only reference attachments they uploaded).
- Resolved bytes feed **both** the model file parts and the `messageImages` array that the
  `insert_image` tool references by index — so the model receives attachment content exactly as
  before (FR-016 scenario 1, SC-005).
- Existing behavior preserved (FR-018): multi-file attachments, per-file size limits, AI quota
  checks, concurrent-stream cap (`MAX_STREAMS_PER_USER`), conversation compaction — and quota/
  stream-cap checks now run without a large-body OOM window in front of them.

## Degraded dev mode (FR-019)

- With S3 unconfigured, attaching an image fails **explicitly and gracefully** (upload → 503 clear
  message), never a crash or silent drop (mirrors the existing doc-image degrade posture).

## Client change

- The chat send path (`AiChatContext.sendMessage(text, files)`) uploads each file to
  `/api/chat/attachments` first, then sends references instead of letting the AI SDK inline the
  bytes as `data:` URLs. Draft persistence and last-message retry continue to work.
