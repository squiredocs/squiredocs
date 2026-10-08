This file is the Squire Docs self-hosting runbook for agents, served at https://squiredocs.com/self-host.md; guidance for contributing to this repository is in CONTRIBUTING.md.

# Self-host Squire Docs

Follow these steps to run Squire Docs on this machine with Docker Compose and
connect yourself to it over MCP. Every step has a command and a success
condition you can check. Run the commands in a shell; nothing prompts.

## 1. Check the prerequisite

```sh
docker compose version
```

Success: exit 0 and a version of 2.24.0 or later (`v2.24.0`, `2.29.1`, and so
on). If the command fails or reports an older version, tell the user to install
or update Docker Desktop or the Docker Compose plugin
(https://docs.docker.com/compose/install/) and stop. Also check that Docker is
running: `docker info` must exit 0.

## 2. Install with one command

Fill the name and email from the user's git identity (`git config user.name`,
`git config user.email`):

```sh
curl -fsSL https://squiredocs.com/install.sh | sh -s -- --name "<name>" --email "<email>"
```

The script creates `./squire-docs`, downloads the release files for the latest
release, verifies them against `SHA256SUMS`, writes `.env`, starts the stack,
waits until every container is healthy, runs `squire doctor`, and prints a
claim link.

Success: exit 0, and the last line of stdout is a claim link of the form
`http://localhost:3910/claim#<token>`. Progress goes to stderr. Options:
`--dir PATH` (install folder), `--version X.Y.Z` (a specific release).

If it fails, it prints one message naming the fix. Apply it, then continue
with step 3 or the recovery steps. Skip step 3 when step 2 succeeded.

## 3. Or run the same steps by hand

Use these instead of step 2 when the user prefers not to pipe a script into a
shell. Run them in order; each must succeed before the next.

```sh
mkdir squire-docs && cd squire-docs
```

Success: exit 0, and the current folder is the new, empty `squire-docs`.

```sh
curl -fsSLO https://github.com/squiredocs/squiredocs/releases/latest/download/compose.yml
```

Success: exit 0, and `compose.yml` exists in the folder.

```sh
curl -fsSLO https://github.com/squiredocs/squiredocs/releases/latest/download/squire && chmod +x squire
```

Success: exit 0, and `squire` exists and is executable. It is a one-line
wrapper for people; agents use the full `docker compose exec` form below.

```sh
docker compose up -d --wait
```

Success: exit 0. Every container reports healthy. The first start pulls the
images and can take a few minutes.

```sh
docker compose exec app squire doctor
```

Success: exit 0. A non-zero exit names the failed check and how to fix it.

```sh
docker compose exec app squire claim-link --name "<name>" --email "<email>"
```

Success: exit 0, and stdout is exactly one line, the claim link. Explanations
go to stderr. A person in the folder can type the short form,
`./squire claim-link`; use the full form above.

## 4. Give the user the claim link

Print the claim link bare, on its own line, with nothing appended: no
punctuation, no quotes, no markdown link syntax. The user opens it, checks the
prefilled name and email, and clicks Continue. That signs them in as the owner
of this instance with a welcome document. The link works once and expires
after 15 minutes.

## 5. Connect yourself over MCP

For Claude Code:

```sh
claude mcp add --transport http squire-local http://localhost:3910/mcp
```

Then make your first tool call through the `squire-local` server (for example
`list_documents`). Claude Code opens an authorization page in the user's
browser; it already has the owner's session from the claim link, so it shows a
consent card. Ask the user to click Approve. Use only the `squire-local`
server's tools for this instance. If `SQUIRE_PORT` is set in `.env`, use that
port instead of 3910.

Success: after the user approves, the tool call returns a result instead of an
authorization error.

On a machine with no browser, create an API token instead:

```sh
docker compose exec app squire token create --name "<agent name>"
```

Success: exit 0. The `sk_sqd_` token is written to a file with mode 0600 under
the container's data directory, and stderr names the file and the
`docker compose cp` command that copies it to `~/.squire/token` on this
machine. Never print, echo, or paste the token into the conversation.

## Recovery

Run these in the install folder (`squire-docs`).

- **The link expired or was used.** Mint a new one:
  `docker compose exec app squire claim-link`. On a claimed instance it signs
  the owner in again.
- **The startup-log link.** An instance with no owner logs a claim link when it
  starts. Find it with `docker compose logs app`.
- **Port 3910 is taken.** Add `SQUIRE_PORT=3911` (any free port) to `.env`,
  then run `docker compose up -d --wait`. Use the new port in the claim link
  and in `claude mcp add`.
- **Something is not healthy.** Read the log with `docker compose logs app`,
  check `docker compose ps`, and run `docker compose exec app squire doctor`.
  `curl -fsS http://localhost:3910/ready` exits 0 when the app can serve
  requests.
- **Upgrade.** Set `SQUIRE_VERSION` in `.env` to the new release (for example
  `SQUIRE_VERSION=1.2.0`), then run:
  `docker compose pull && docker compose up -d --wait`. Migrations run on boot.

## Stopping safely

`docker compose down` stops the instance and keeps every document.

**Never run `docker compose down -v`** unless the user explicitly asks to delete
everything. It deletes the volumes: every document, the owner account, and the
generated encryption key in the `squire-data` volume. Losing that key makes
stored API keys unreadable, and there is no way to recover any of it.

## Exposing the instance

Plain HTTP is supported only on localhost. Exposing an instance to other
machines requires a TLS-terminating proxy in front of it and an https
`APP_URL` in `.env`.

More detail for people: https://squiredocs.com/documentation/self-hosting
