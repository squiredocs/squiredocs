# Contract: HTTP Routes (058)

## New routes

### `GET /api/docs/:docId/images/:imageId/raw`

- **Auth**: `requireAuthOrCookie` (Authorization header, else the `accessToken`
  cookie). Scoped tokens need `documents:read`.
- **Access**: `documents.hasAccess(docId, userId)` (viewer or better), the same
  check the resolve route performs.
- **Responses**:
  - `200` body is the image bytes. Headers: `Content-Type` from
    `document_images.mime_type`; `Cache-Control: private, no-cache` (revalidated via ETag so revoked access applies at once; 058 review L2);
    `X-Content-Type-Options: nosniff`;
    `Content-Security-Policy: default-src 'none'; sandbox`.
  - `401` `{ "error": "No authorization header" }` or
    `{ "error": "Invalid or expired token" }` (same bodies as `requireAuth`).
  - `403` `{ "error": "Access denied" }`.
  - `404` `{ "error": "Image not found" }` for an unknown image id, an image of
    another document, or a row whose bytes are missing from the active driver.
  - `503` `{ "error": "Image storage is not configured" }` when the driver is
    not enabled.
  - `500` `{ "error": "Failed to read image" }` on a driver error (logged and
    sent to `notifyException`).
- **Trust boundary (Constitution V)**: read-only; bytes were validated at
  upload (MIME allow-list, size cap). The sandbox CSP and `nosniff` stop a
  stored file from executing even if a future allow-list widens.

### `GET /api/chat/attachments/raw?ref=attachment:<key>`

- **Auth**: `requireAuthOrCookie`.
- **Access**: `attachmentKeyForUser(ref, userId)` (the key must be
  `chat-attachments/<own userId>/<uuid>`).
- **Responses**: `200` with the same headers as above and `Content-Type` from
  the driver metadata; `400` `{ "error": "Invalid or inaccessible attachment reference" }`;
  `404` when the object is missing or its content type is not an allowed image
  type; `503` when storage is off; `500` on driver error.

## Changed routes

| Route | Change |
| --- | --- |
| `GET /api/docs/:docId/images/:imageId` | Local driver: `{ "url": "/api/docs/<docId>/images/<imageId>/raw" }`. S3 driver: unchanged presigned URL. `Cache-Control: no-store` either way. Moved from `server/index.js` into `server/api/document-images-routes.js` unchanged otherwise. |
| `POST /api/docs/:docId/images` | Moved with the router; storage through the facade. Same 201 body, same 503 when the driver is not enabled. |
| `GET /api/chat/attachments/resolve` | Local driver: `{ "url": "/api/chat/attachments/raw?ref=<encodeURIComponent(ref)>" }`. S3: unchanged. |
| `GET /api/usage` | Not hosted: adds `"notApplicable": true` and `"allowed": true`; other fields keep their meaning. Hosted: unchanged. |
| `POST /api/admin/users/:userId/welcome-email` | Not hosted: unregistered (Express default 404). Hosted: unchanged except the 503 text names `SMTP_FROM`. |
| `POST /auth/prod-reset-selftest-account` | Not hosted: unregistered (default 404). Hosted: unchanged. |
| `GET /agents.md` | Not hosted: `text/markdown; charset=utf-8`, every `https://squiredocs.com` replaced by the request's base URL (`buildBaseUrl`). Hosted: static file as today. |
| `GET /`, `/index.html`, and the SPA catch-all | Serve the injected shell (see below). Hosted `/` stays `landing.html`. |
| `/pricing`, `/about`, `/security`, `/blog`, `/blog/*`, `/privacy`, `/terms`, `/landing.html`, `/pricing.html`, `/about.html`, `/security.html` | Not hosted: `404 text/plain "Not found"`. Hosted: unchanged. |
| Every response | CSP `script-src`, `img-src`, `connect-src` drop the Google sources when not hosted; `img-src` carries the S3 or `S3_ENDPOINT` origin only for the S3 driver. |
| Requests with `Host: herodocs.xyz` or `heradocs.com` | Not hosted: no 301. |

## Application shell contract

The served shell contains, immediately after `<head>`:

```html
<!-- hosted only: the Google tag snippet, unchanged from today's index.html -->
<script>window.__SQUIRE_INSTANCE__={"hosted":true}</script>
```

The object carries only the hosted flag. It is the only channel the client
uses to learn the flag (no request, no auth). `client/src/instance.js`
`isHosted()` returns `true` only for the literal boolean `true`.

## Unchanged

`/health`, `/ready`, `/documentation*`, `/mcp*`, `/.well-known/*`,
`/auth/*` other than the self-test reset, and every other `/api/*` route.
