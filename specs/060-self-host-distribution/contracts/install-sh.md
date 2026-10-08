# Contract: `install.sh`

Source: `distribution/self-host/install.sh` (mode 100755). Served verbatim at
`/install.sh` on every instance (see `served-routes.md`). POSIX `sh`; passes
`shellcheck -s sh` with no errors. Never reads stdin. Above `main()` the file
holds only assignments and function definitions, and its last line is
`{ main "$@"; }`, so a download cut short anywhere runs nothing (review
finding H1).

## Invocation

```text
sh install.sh [--dir PATH] [--version X.Y.Z] [--name NAME] [--email EMAIL]
curl -fsSL https://squiredocs.com/install.sh | sh -s -- --name "Ada" --email "ada@example.com"
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--dir PATH` | `./squire-docs` | Created if missing. Must be absent or empty (hidden files count); see the refusals below. |
| `--version X.Y.Z` | latest non-prerelease | No `v`. A leading `v` is a usage error naming the form. |
| `--name NAME` | none | Passed to `squire claim-link --name`. |
| `--email EMAIL` | none | Passed to `squire claim-link --email`. |
| `--help` | | Usage on stderr, exit 0. |

Unknown flag, flag without value, or positional argument: usage on stderr, exit 2.

| Environment | Default | Notes |
| --- | --- | --- |
| `SQUIRE_INSTALL_ASSET_URL` | `https://github.com/<REPOSITORY>/releases/download/v<version>` | Base URL for the four assets (RBD-060-6). Changes nothing else. Documented in the header comment only. |
| `SQUIRE_PORT` | `3910` | Host port. When set (non-empty) it must be 1 to 65535, and it is written to `.env` so later `docker compose` and `./squire` commands use the same port (review finding M6, RBD-060-42). |

## Output discipline

- stdout: exactly one line on success, the claim link
  (`^https?://[^ ]+/claim#[A-Za-z0-9_-]+$`), then nothing. Nothing on failure.
- stderr: all progress, Docker output, doctor output, and errors.
- `sh install.sh ... | tail -n 1` is the link.

## Exit codes and messages (first failure wins)

| Condition | Exit | Message names |
| --- | --- | --- |
| Usage error | 2 | the flag and `--help` |
| `REPOSITORY` still a placeholder | 1 | "has not been released yet" |
| `SQUIRE_PORT` set but not 1 to 65535 | 1 | "is not a port number" |
| `docker` missing or `docker compose version` fails | 1 | install Docker Compose v2 (link to Docker's install page) |
| Compose v1, or v2 older than 2.24.0 | 1 | the found version and "Docker Compose 2.24 or later" |
| `docker info` fails | 1 | start Docker (Docker Desktop or the docker service) |
| `curl` missing | 1 | install curl |
| neither `sha256sum` nor `shasum` | 1 | install coreutils or perl's shasum; verification is never skipped |
| `<dir>/compose.yml` exists | 1 | the upgrade command (below), with the folder path |
| `<dir>` exists and is not a folder | 1 | "Choose a new or empty folder with --dir" |
| `<dir>` is a non-empty folder without `compose.yml` | 1 | the folder and "never overwrites your files"; nothing downloaded (review finding H2, RBD-060-40) |
| latest version cannot be resolved | 1 | `--version` |
| a download fails | 1 | the asset name and the release version; files from this run removed |
| a checksum mismatch | 1 | the file name; files from this run removed; nothing started |
| `docker compose up -d --wait` fails, port conflict | 1 | `Port <p> is in use. Set SQUIRE_PORT in <dir>/.env and run docker compose up -d --wait again.` |
| `docker compose up -d --wait` fails, other | 1 | `docker compose logs app` (run in `<dir>`) |
| `./squire doctor` fails | 1 | doctor's own output, then "Fix the failed check, then run ./squire claim-link" |
| `claim-link` fails or prints a non-link | 1 | `./squire claim-link` |

Upgrade command text (FR-018, RBD-060-16), printed for an existing install:

```text
Squire Docs is already installed in <dir>.
To upgrade, set SQUIRE_VERSION in <dir>/.env to the new release<, for example X.Y.Z>, then run:
  cd <dir> && docker compose pull && docker compose up -d --wait
```

## Steps (success path)

1. Prerequisites as above.
2. Create `<dir>` (or use it when it exists and is empty).
3. Download `SHA256SUMS`, `compose.yml`, `squire`, `env.example`; verify the
   three against `SHA256SUMS`; rename `env.example` to `.env.example`;
   `chmod +x squire`; write `.env` as `SQUIRE_VERSION=<version>`,
   `COMPOSE_PROJECT_NAME=squire-docs-<8 random hex digits>` (review finding M1,
   RBD-060-41), and `SQUIRE_PORT=<port>` when `SQUIRE_PORT` is set. Every
   later `docker compose` and `./squire` call runs in `<dir>`, where Compose
   reads `.env`.
4. In `<dir>`: `docker compose up -d --wait`, then `./squire doctor`.
5. `./squire claim-link [--name ...] [--email ...]`; print its single line to stdout.

## Cleanup rule (FR-016)

Before step 4 starts, any failure removes exactly the files this run created
and the folder if this run created it. Because the folder was absent or empty,
those files can never be ones the user already had. From step 4 on, nothing is removed.
Volumes are never removed.

## Test hooks (Docker-free)

`test/self-host/install-sh.test.mjs` runs the script with `PATH` set to
`test/self-host/fixtures/stub-bin` plus `/usr/bin:/bin` minus the real
`docker`, with stubs for `docker` (behavior chosen by `STUB_DOCKER_*`
environment variables, records its argv to a log file), `curl` (serves files
from a fixture directory, or fails for a named asset), and the checksum tools
(present or absent per test). The real `sha256sum` is used when present so
checksum mismatch is real.
