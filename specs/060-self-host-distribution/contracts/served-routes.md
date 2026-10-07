# Contract: served routes

## `GET /self-host.md` and `GET /install.sh` (FR-013, FR-021, RBD-060-2)

| Route | Source in the image | Content-Type | Body |
| --- | --- | --- | --- |
| `GET /self-host.md` | `/app/AGENTS.md` | `text/markdown; charset=utf-8` | bytes of `AGENTS.md`, unmodified |
| `GET /install.sh` | `/app/distribution/self-host/install.sh` | `text/x-shellscript; charset=utf-8` | bytes of the script, unmodified |

- Mounted by `mountDistributionRoutes(app, { repoRoot })` in
  `server/web-routes.js`, called first in `mountWebRoutes` (before the
  client-build check and before the hosted/not-hosted split), so both
  instance kinds serve them identically.
- `Cache-Control: public, max-age=300`. `HEAD` supported (Express default).
- Files are read once at mount. A missing file leaves its route unmounted (the
  request falls through to the shell or 404 as today).
- No origin substitution, no authentication, no query handling.
- Hosted parity: every other route's behavior and bytes are unchanged
  (`hosted-parity.test.js` keeps passing unmodified).

Tests (`server/__tests__/self-host-routes.test.js`): for `SQUIRE_HOSTED=true`
and unset, both routes return 200, the exact content type, and a body
`Buffer.equals` the repository file; a `Host: evil.example` header changes
nothing; `/agents.md` behavior unchanged in both modes.

Vite dev: `client/vite.config.js` proxies `/self-host.md` and `/install.sh`
to the backend so the dev server and production agree.

## Documentation routes, not hosted (FR-030, FR-031)

`mountDocumentationRoutes(app, docsDistDir, { transformHtml } = {})`:

- Without `transformHtml` (hosted): unchanged, `res.sendFile`.
- With `transformHtml`: every served page (including the 404 page) is read
  once at mount into memory and sent as
  `transformHtml(html, req)` with `Content-Type: text/html; charset=utf-8`.
- Routing, redirects, slug set, and nested-path 404s are unchanged.

`web-routes.js` not-hosted branch mounts
`path.join(clientBuildPath, 'documentation', '_self-hosted')` with
`transformHtml = (html, req) => html.split('__SQUIRE_ORIGIN__').join(safeOrigin(req))`,
where `safeOrigin(req)` is `buildBaseUrl(req)` if `new URL(v).origin === v`
and the protocol is http or https, else `getInstanceConfig().appUrl`, then
HTML-escaped.

Tests: not-hosted pages contain no `googletagmanager`, no `rel="canonical"`,
no `og:url`, no `__SQUIRE_ORIGIN__`, and show `http://localhost:3910/mcp`
for `Host: localhost:3910`; a hostile `Host` value never appears unescaped;
`/documentation/_self-hosted/index.html` and `/documentation/_self-hosted`
return the documentation 404 on both instance kinds.
