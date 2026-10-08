# Contributing to Squire Docs

Thanks for helping improve Squire Docs. This file covers how to set up, test,
and submit a change. If you want to run Squire Docs rather than work on it,
see [AGENTS.md](AGENTS.md) or https://squiredocs.com/documentation/self-hosting.

## Before you start

Open an issue at https://github.com/squiredocs/squiredocs/issues before a large
change, such as a new feature, a new dependency, or a change to how documents
are stored or synced, so we can agree on the approach first. Small fixes can go
straight to a pull request.

## Setting up

[docs/dev.md](docs/dev.md) describes the development environment: the
database, Redis, environment variables, and how to run the server and the
client. [README.md](README.md) describes the application and its architecture.

## Running the tests

Every change needs tests that cover it. Run the suites that touch your change,
and all of them before you open a pull request:

- `npm test` runs the server and client suites.
- `npm run test:server` runs the server suite (Jest; needs Postgres and Redis).
- `npm run test:client` runs the client suite (Vitest).
- `npm run test:first-run` runs the plugin bundle and onboarding checks.
- `npm run test:self-host` runs the self-host distribution checks (the install
  script, the compose file, and the release workflow). It needs no Docker.

## Submitting a change

Send a pull request against `main`. The maintainer reviews it and merges it to
`main`; there is no other process to follow. Keep each pull request to one
change, and say what it fixes and how you tested it.

The project's design documents live in `design/` and the feature
specifications in `specs/`. A change that alters designed behavior should say
which part of the design it changes.

## Writing style

User-facing text (the app, the documentation pages, error messages) follows a
few rules:

- Plain, direct sentences.
- No em dashes.
- Say "Squire Docs", never just "Squire", when naming the product.
- In the documentation, "documentation" means these help pages and "documents"
  means what people write in Squire Docs.

## License

Squire Docs is released under the MIT license (see [LICENSE](LICENSE)). By
contributing, you agree that your contributions are licensed under the same
MIT license. No DCO sign-off and no contributor license agreement are needed.

## Security issues

Do not report security issues in public issues or pull requests. See
[SECURITY.md](SECURITY.md).
