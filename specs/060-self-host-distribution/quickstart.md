# Quickstart: validating 060

Two halves. Part A runs anywhere, including the app-dev pod (no Docker). Part B
runs only in GitHub Actions (or on a maintainer machine with Docker). Contracts
hold the details; this file lists the runs and what passing looks like.

## Part A: Docker-free (pod and `test.yml`)

Run from the repository root.

1. **Distribution suite**

   ```sh
   npm run test:self-host
   ```

   Passes: `install-sh`, `compose-and-assets`, `release-script`,
   `repository-constant`, `agents-md`, `release-workflow`. In the pod the
   shellcheck case prints "shellcheck not installed; skipped" and still
   passes; in `test.yml` it runs.

2. **Served routes and documentation mount (Jest)**

   ```sh
   npx jest server/__tests__/self-host-routes.test.js server/__tests__/hosted-parity.test.js server/__tests__/web-routes.test.js
   ```

   Passes: byte pins for `/self-host.md` and `/install.sh` in both modes;
   hosted parity untouched; not-hosted documentation pages carry no Google
   tag and show the request origin.

3. **Documentation variant and hosted golden hashes (Vitest)**

   ```sh
   npm run test:client -- documentation
   cd client && npm run build && ls dist/documentation/_self-hosted/ && cd ..
   ```

   Passes: hosted hashes match the recorded fixture; variant assertions hold;
   the build writes both directories and its own sentinel and tag checks pass.

4. **Bundles**

   ```sh
   node distribution/publish.mjs
   npm run test:first-run
   git diff --stat distribution/
   ```

   Passes: drift guard and budgets green; `claude-plugin/commands/onboard.md`
   carries the self-host pointer; the three LICENSE files name 21st Harmonic
   LLC; `.mcp.json` URL is still `https://squiredocs.com/mcp`. Never pass
   `--publish`.

5. **Release script by hand**

   ```sh
   node distribution/self-host/release.mjs validate --tag v1.2.3 --github-repository samg/collab   # exit 1: placeholder
   node distribution/self-host/release.mjs stamp --version 1.2.3 --out /tmp/assets && (cd /tmp/assets && sha256sum -c SHA256SUMS)
   ```

6. **Driver sign-in-link leg against the dev server** (dev server running in
   the pod on 3001)

   ```sh
   LINK=$(node bin/squire.js claim-link 2>/dev/null)
   node test/first-run/oauth-chain-driver.mjs --server http://localhost:3001 --signin-link "$LINK" --script-check
   node test/first-run/oauth-chain-driver.mjs --server http://localhost:3001            # default leg still works
   node test/first-run/oauth-chain-driver.mjs --server http://localhost:3001 --first-run
   ```

   The dev instance already has users, so `claim-link` mints a sign-in link
   for the owner; the leg is the same. If the dev database has no resolvable
   owner, use `node bin/squire.js login-link --email <dev admin email>`.

7. **install.sh by hand with a stub Docker** (optional; the suite does this)

   ```sh
   PATH="$PWD/test/self-host/fixtures/stub-bin:$PATH" STUB_DOCKER_COMPOSE_VERSION=2.29.1 \
     SQUIRE_INSTALL_ASSET_URL=file:///tmp/assets sh distribution/self-host/install.sh --version 1.2.3 --dir /tmp/sq | tail -n 1
   ```

   Note: `install.sh` refuses while `REPOSITORY` is the placeholder; the test
   suite runs a copy with the constant replaced.

## Part B: GitHub Actions only (`release.yml`)

Preconditions: `REPOSITORY` set to the real `owner/name` (equal to the
repository running the workflow); the repository public (arm64 runners) or a
dispatch with `allow_single_arch`.

1. **Dry run**: Actions, "Release", Run workflow on `main` with defaults.
   Expect `validate`, `build-amd64`, `build-arm64`, and `agent` green, and
   `publish` skipped with the summary "dispatch from a branch never publishes".
   The `agent` job log ends with the driver's success line.
2. **Prerelease**: `git tag v1.0.0-rc.1 && git push origin v1.0.0-rc.1`.
   Expect `ghcr.io/<REPOSITORY>:1.0.0-rc.1` with two platforms, `latest`
   absent or unchanged, a GitHub pre-release with exactly four assets.
3. **Release**: `git tag v1.0.0 && git push origin v1.0.0`. Expect `1.0.0`
   and `latest` on one digest, both platforms, four assets; then on any
   Docker machine:

   ```sh
   curl -fsSL https://squiredocs.com/install.sh | sh -s -- --name "Ada" --email "ada@example.com"
   ```

   (The second command needs the hosted deploy that carries 060.)
4. **Negative**: push a tag `vnext`; expect `validate` to fail and nothing
   published.
5. **Upgrade check** (maintainer machine): install `1.0.0-rc.1` with
   `--version`, create a document, set `SQUIRE_VERSION=1.0.0` in `.env`, run
   `docker compose pull && docker compose up -d --wait`; the document, owner,
   and `/data/secrets.json` survive (US3 scenario 3).

## Hosted deploy check (Sam)

After merge, the next `script/build-and-deploy-aws.sh` run must succeed
unchanged; then `curl -sI https://squiredocs.com/self-host.md` and
`/install.sh` return 200 with the contract content types, and
`/agents.md`, `/`, and `/pricing` bytes match the pre-deploy capture, and a
documentation page such as `/documentation/editing` differs only by the new
sidebar entry (SC-005, SC-006).
