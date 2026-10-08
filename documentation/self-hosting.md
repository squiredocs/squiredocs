---
slug: self-hosting
title: Self-hosting
description: Run your own Squire Docs instance with Docker Compose, sign in with a claim link, and connect your agent.
order: 10
---

You can run your own Squire Docs instance on your machine with Docker Compose. It needs no account, no API key, and no copy of the source code. Your documents stay on your machine, and your coding agent connects to it over MCP the same way it connects to squiredocs.com.

If you are an agent, follow [https://squiredocs.com/self-host.md](https://squiredocs.com/self-host.md) instead: it lists every step with a command and a success condition. The source code is at [https://github.com/squiredocs/squiredocs](https://github.com/squiredocs/squiredocs).

## Prerequisites

You need Docker Compose 2.24 or later and a running Docker daemon. Docker Desktop includes both. Check with:

```
docker compose version
```

The install script also needs `curl` and `sha256sum` (or `shasum` on macOS), which most systems already have.

## Install with one command

Run this in the folder where you want the install folder to live, with your own name and email:

```
curl -fsSL https://squiredocs.com/install.sh | sh -s -- --name "Ada Lovelace" --email "ada@example.com"
```

When it finishes, the last line it prints is a claim link. If you would rather read the script before running it, open [https://squiredocs.com/install.sh](https://squiredocs.com/install.sh); the manual steps in [self-host.md](https://squiredocs.com/self-host.md) do the same thing by hand.

The script accepts `--dir PATH` to choose the install folder (the default is `./squire-docs`) and `--version X.Y.Z` to install a specific release instead of the latest one. The folder must be new or empty, so the script never overwrites your files. If `SQUIRE_PORT` is set when you run it, the script uses that port and saves it in `.env`.

## What the install script does

1. Checks that Docker Compose 2.24 or later is installed and that Docker is running, and stops with a message naming the fix if not.
2. Creates the `squire-docs` folder. If the folder already holds an installation, it changes nothing and prints the upgrade command instead. If it holds anything else, it stops without changing anything.
3. Downloads the release files (`compose.yml`, the `squire` wrapper, `.env.example`, and `SHA256SUMS`), checks every file against `SHA256SUMS`, and writes `.env` with the release version and a Compose project name unique to this install.
4. Starts the stack with `docker compose up -d --wait`, which returns once the app, Postgres, and Redis are all healthy, then runs `./squire doctor`.
5. Prints a claim link as the last line of its output.

It never prompts, so an agent can run it unattended. If a step fails, it exits with one message that says what to do next.

## Sign in with a claim link

Open the claim link, check the name and email on the page, and click Continue. You are signed in as the owner of the instance, with a welcome document. A new instance runs in local mode: one owner account, signed in with links like this one, and no sign-up page. Team mode, for instances shared by several people, is coming in a later release.

A link works once and expires after 15 minutes. To get a new one, run this in the install folder:

```
./squire claim-link
```

`./squire` is a small wrapper for `docker compose exec app squire`. On a claimed instance the same command signs the owner in again, which is also how you get back in after a week without using the instance.

An instance with no owner also prints a claim link in its startup log. Find it with:

```
docker compose logs app
```

## Connect your agent

For Claude Code, run:

```
claude mcp add --transport http squire-local http://localhost:3910/mcp
```

Then ask your agent to use Squire Docs. On its first tool call, Claude Code opens an authorization page in your browser. You are already signed in from the claim link, so click Approve. If you set `SQUIRE_PORT` to something other than 3910, use that port in the URL.

The name `squire-local` keeps this instance's tools separate from the hosted service's, so an agent with both connected cannot mix them up.

On a machine without a browser, create an API token instead:

```
./squire token create --name "Claude Code"
```

The token is written to a file with mode 0600 inside the instance's data volume, and the command prints how to copy it to your machine. See [Agents and MCP](/documentation/agents-and-mcp) for what an agent can do once connected.

## Without an API key

Everything your own agent does over MCP works without a key: the editor, version history, sharing, import and export, and every MCP tool. Your agent supplies the AI.

A key adds features that call a model from inside Squire Docs. An assistant key (Anthropic, OpenRouter, or Google) turns on the in-app assistant for everyone on the instance; without one, each person can still add their own key in Settings. A Google key (`GOOGLE_GENERATIVE_AI_API_KEY`) also turns on semantic search. Without it, search matches words in the text. `./squire doctor` reports which of these are on.

## Configuration

Settings go in `.env` in the install folder. `.env.example` lists the ones you can set, each commented out with its default: copy a line into `.env`, set the value, and run `docker compose up -d --wait` to apply it.

- `SQUIRE_PORT`: the port on your machine, 3910 by default. Change it if 3910 is taken.
- Assistant keys: `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and `GOOGLE_GENERATIVE_AI_API_KEY`.
- Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and `SMTP_SECURE`. Without `SMTP_HOST`, the instance sends no email.
- Images: stored in the data volume by default. To use S3 or an S3-compatible service, set `STORAGE_DRIVER=s3`, `S3_IMAGE_BUCKET`, `S3_IMAGE_REGION`, `S3_ENDPOINT` (for services such as MinIO), `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`.
- `APP_URL`: the instance's public URL. It follows `SQUIRE_PORT` as `http://localhost:<port>`; set it only when you expose the instance behind a TLS proxy (see below).

## Upgrading

An install is pinned to one release, so upgrading takes two steps. First set `SQUIRE_VERSION` in `.env` to the new release, for example `SQUIRE_VERSION=1.2.0`. Then run, in the install folder:

```
docker compose pull && docker compose up -d --wait
```

Database migrations run when the new version starts. Your documents, owner account, and settings carry over.

## Backing up

Your data lives in three Docker volumes: `squire-data` (generated secrets, including the encryption key for stored API keys, and image files), `postgres-data` (documents, accounts, and version history), and `redis-data` (short-lived state). Compose prefixes each volume with the `COMPOSE_PROJECT_NAME` in `.env` (for example `squire-docs-1a2b3c4d_postgres-data`), which keeps two installs on one machine apart. Keep that line when you edit `.env`: without it, Compose starts a new, empty instance. Back up the first two volumes. For example, in the install folder:

```
docker compose exec -T postgres pg_dump -U squire squire > squire-docs.sql
docker compose cp app:/data ./squire-data-backup
```

Keep the `squire-data` copy private: it holds the instance's secrets.

## Stopping safely

`docker compose down` stops the instance and keeps everything. Start it again with `docker compose up -d --wait`.

`docker compose down -v` deletes the volumes: every document, the owner account, and the generated encryption key. There is no way to recover them. Run it only when you mean to delete the instance.

## Exposing an instance

Plain HTTP is supported only on localhost. The app listens on 127.0.0.1, so other machines cannot reach it. To expose an instance, put a TLS-terminating proxy (such as Caddy, nginx, or a cloud load balancer) in front of it and set an https `APP_URL` in `.env`, for example `APP_URL=https://docs.example.com`. `./squire doctor` fails when `APP_URL` is neither localhost nor https.

Postgres and Redis publish no ports, and their credentials in `compose.yml` are reachable only inside the compose network. If you change `compose.yml` to expose either one, securing it is up to you.

## Windows

Use Docker Desktop with WSL 2 and run the install command in a WSL terminal. The `./squire` wrapper is a shell script; in PowerShell or Command Prompt, run `docker compose exec app squire` with the same arguments instead, for example `docker compose exec app squire claim-link`.

## Getting help

Report problems and ask questions in the issues at [https://github.com/squiredocs/squiredocs/issues](https://github.com/squiredocs/squiredocs/issues). Report security issues privately to security@squiredocs.com, not in a public issue.
