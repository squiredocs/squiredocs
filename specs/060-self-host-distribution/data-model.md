# Data Model: Self-Host Distribution (060)

No database entities change. **No migration.** The "data" in this feature is
files, tags, and their states. Each entity below names its validation rules and
the test that enforces them.

## Repository constant

| Field | Value | Rules |
| --- | --- | --- |
| `REPOSITORY` | `<org>/<repo>` until Sam decides (RBD-060-1, RBD-060-20) | Defined once in `distribution/self-host/release.mjs`. Lowercase `owner/name` when real. Every `github.com/<x>/<y>` release URL and `ghcr.io/<x>/<y>` image reference in `AGENTS.md`, `install.sh`, `compose.yml`, and `documentation/self-hosting.md` equals it (`repository-constant.test.mjs`). The release workflow refuses a value containing `<` or `>`, or one not equal to the lowercased `github.repository`. |

## Release

| Field | Source | Rules |
| --- | --- | --- |
| `tag` | git tag | `^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$`; anything else publishes nothing (FR-010, US3 scenario 5). |
| `version` | `tag` without `v` | What `SQUIRE_VERSION` and the image tag hold. |
| `prerelease` | suffix present | `latest` moves only when false; GitHub release marked pre-release when true; `install.sh` without `--version` never selects one (the `releases/latest` redirect skips prereleases). |
| `image` | `ghcr.io/<REPOSITORY>` | One manifest list with `linux/amd64` and `linux/arm64` (single-arch only with the explicit dispatch input). |
| `assets` | `release.mjs stamp` | Exactly `compose.yml`, `squire`, `env.example`, `SHA256SUMS` (RBD-060-21). |

State: `tag pushed` -> `validated` -> `built (per arch)` -> `smoked (per arch)`
-> `agent-verified (amd64)` -> `published` (image tags, then GitHub release).
Any failed transition ends the run with nothing published.

## Release asset

| Asset | Repository source | Stamping | Installed as |
| --- | --- | --- | --- |
| `compose.yml` | `distribution/self-host/compose.yml` | `__SQUIRE_VERSION__` -> `X.Y.Z` | `compose.yml` |
| `squire` | `distribution/self-host/squire` | none; mode 0755 | `squire` (chmod +x) |
| `env.example` | `distribution/self-host/.env.example` | `__SQUIRE_VERSION__` -> `X.Y.Z` | `.env.example` |
| `SHA256SUMS` | generated | `sha256sum` format, three lines, sorted by name | `SHA256SUMS` (kept; it names the asset `env.example`, RBD-060-21) |

Rules: after stamping, no asset contains `__SQUIRE_`, `<org>`, or `<repo>`;
`SHA256SUMS` verifies with both `sha256sum -c` and `shasum -a 256 -c`.

## Install folder

| Path | Created by | Notes |
| --- | --- | --- |
| `<dir>/` | `install.sh` (if absent or empty) or the user | Default `./squire-docs`. |
| `compose.yml` | download | Its presence alone means "an installation" (RBD-060-15). |
| `squire` | download | Executable. |
| `.env.example` | download (`env.example`) | Reference only. |
| `SHA256SUMS` | download | Kept, so US1's "four release files present" holds. |
| `.env` | `install.sh` | One line, `SQUIRE_VERSION=X.Y.Z`. The manual path writes none (the compose default applies). |

States as `install.sh` sees them:

- `fresh`: folder missing, or present without `compose.yml` -> install.
- `installed`: `compose.yml` present -> refuse, print the upgrade command, exit 1.
- `partial` (inside one run): files downloaded, stack not started -> on any
  failure, remove exactly the files this run created, and the folder if this
  run created it, so the next run sees `fresh`.
- `started`: `docker compose up` was attempted -> no cleanup; a rerun sees
  `installed` and prints the upgrade command, which doubles as the restart
  hint (RBD-060-16).

## Claim link (transported, not owned)

`http(s)://<host>[:port]/claim#<token>`, token `[A-Za-z0-9_-]+`. Minted by
059's `squire claim-link`; `install.sh` checks the shape and prints it as the
only stdout line; the driver's `--signin-link` leg parses the fragment.

## Documentation page variant

| Variant | Built to | Served by | Differences from hosted |
| --- | --- | --- | --- |
| `hosted` | `client/dist/documentation/*.html` | hosted instances (sendFile) | none (golden hashes) |
| `self-hosted` | `client/dist/documentation/_self-hosted/*.html` | not-hosted instances (read once, `__SQUIRE_ORIGIN__` substituted per request) | no Google tag; no canonical or `og:url`; header and footer filtered by `keepSelfHostedHref`; empty footer columns removed; instance URLs carry the sentinel; hosted-only body links absolute to `https://squiredocs.com` |

Rules: the `_self-hosted` directory is never addressable by URL; the sentinel
never appears in hosted output; the substituted origin is a validated http(s)
origin, HTML-escaped, with `APP_URL` as the fallback.

## Documentation page set

| Slug | Order | Change |
| --- | --- | --- |
| `agents-and-mcp` | 9 | Codex section only if verified (FR-034) |
| `self-hosting` | 10 | new (RBD-060-9) |
| `markdown` | 11 | was 10 |
| `appearance` | 12 | was 11 |
| `account-and-support` | 13 | was 12 |

## Plugin channel versions

| Channel | Constant | From | To | Why |
| --- | --- | --- | --- | --- |
| Claude plugin | `SHIP_VERSION` | 1.0.1 | 1.0.2 | onboard pointer, LICENSE holder |
| MCP registry | `REGISTRY_VERSION` | 1.0.2 | 1.0.3 | LICENSE holder |
| Cursor plugin | `CURSOR_PLUGIN_VERSION` | 1.0.0 | 1.0.1 | LICENSE holder |
| Kiro power | `KIRO_POWER_VERSION` | 1.0.0 | 1.0.0 | unchanged content |
