# Contract: documentation variants

Module: `client/scripts/render-documentation.mjs`.

## New and changed exports

```text
renderPage({ page, allPages, canonicalOrigin, variant = 'hosted' }) -> string
render404({ allPages, canonicalOrigin, variant = 'hosted' })       -> string
keepSelfHostedHref(href)        -> boolean
filterNavHtml(html)             -> string   // drops <a> elements whose href fails keepSelfHostedHref
filterFooter(footerHtml)        -> string   // drops <li> items by href, then empty columns
renderVariantBody(bodyHtml, variant) -> string
ORIGIN_SENTINEL = '__SQUIRE_ORIGIN__'
HOSTED_ONLY_PATHS               // ['/pricing','/about','/blog','/security','/privacy','/terms'] (+ '/blog/' prefix)
```

`variant: 'hosted'` output is byte-identical to the current output for the
same inputs (golden hashes).

## `keepSelfHostedHref(href)`

Returns false for `mailto:` hrefs, `/signup`, any `HOSTED_ONLY_PATHS` entry
(case-insensitive, trailing slash ignored), and any path under `/blog/`.
Returns true for everything else, including absolute external URLs
(`https://github.com/...`), `/`, `/documentation...`, `/login`,
`/agents.md`, and hrefs this list has never seen. A Vitest test asserts
`HOSTED_ONLY_PATHS` agrees with `server/web-routes.js`'s `isHostedOnlyPath`
for every listed path.

## Self-hosted page shape

- `<head>`: no Google tag snippet; no `<link rel="canonical">`; no
  `og:url`; `og:title`, `og:description`, `og:type` kept.
- Header nav: `filterNavHtml(HEADER)`, which leaves Documentation and Sign In.
- Footer: `filterFooter(FOOTER)`. With today's `FOOTER`: Product column keeps
  Documentation, Agents (`/agents.md`), GitHub, Sign In; Legal and Contact
  columns are removed; brand block and copyright line kept. With a
  062-shaped `FOOTER` (new tagline, an extra `<li><a
  href="/documentation/self-hosting">Self-host</a></li>`), the tagline and
  the Self-host item survive (fixture test).
- Body (`renderVariantBody`): occurrences of `https://squiredocs.com/mcp` and
  `https://squiredocs.com/api/` become `__SQUIRE_ORIGIN__/mcp` and
  `__SQUIRE_ORIGIN__/api/`; `href="<hosted-only path>"` becomes
  `href="https://squiredocs.com<path>"`. Nothing else changes (email
  addresses, `https://squiredocs.com/install.sh`,
  `https://squiredocs.com/self-host.md`, GitHub URLs).

## Build output

`build-documentation.mjs` writes, after the terminology gate:

- `client/dist/documentation/<slug>.html`, `index.html`, `404.html` (hosted,
  unchanged code path);
- `client/dist/documentation/_self-hosted/<slug>.html`, `index.html`,
  `404.html` (variant).

A build-time assertion fails the build if any hosted file contains
`__SQUIRE_ORIGIN__` or any variant file contains `googletagmanager`,
`rel="canonical"`, or `og:url`.

## Vite dev

`documentationPagesPlugin` renders `variant: SQUIRE_HOSTED ? 'hosted' :
'self-hosted'` and, for the self-hosted variant, replaces the sentinel with
the dev request's `http://<host>` origin (escaped).

## The `self-hosting` page (FR-029, FR-040)

Frontmatter: `slug: self-hosting`, `title: Self-hosting`, `order: 10`,
description per RBD-060-9. Sections, in order: Prerequisites (Docker Compose
2.24+); Install with one command; What the install script does; Sign in with
a claim link (`./squire claim-link`, `docker compose logs app` for the
startup-log link); Connect your agent (`claude mcp add --transport http
squire-local http://localhost:3910/mcp`, with a sentence about a changed
`SQUIRE_PORT`; the token fallback); Without an API key (what works, what a
key adds, semantic search); Configuration (`.env`, port, keys, SMTP, S3,
`APP_URL`); Upgrading (two steps, RBD-060-16); Backing up (the three volumes;
the encryption key lives in `squire-data`); Stopping safely (`down` versus
`down -v`); Exposing an instance (TLS proxy and https `APP_URL` only; plain
HTTP only on localhost; exposed Postgres or Redis is on the operator); Windows
(run `docker compose exec app squire` directly); Getting help (GitHub issues,
`security@squiredocs.com`). Links to `https://squiredocs.com/self-host.md` for
agents and to `https://github.com/<REPOSITORY>`. Says "Squire Docs", never
bare "Squire"; names no password, OIDC, or team-mode provider feature (one
sentence that team mode is coming is allowed).
