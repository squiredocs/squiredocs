# Development Environment Guide

This guide explains how to work with the Kubernetes-based development environment using Minikube and Mutagen for file synchronization.

> **Operating production?** This guide is local-dev only. Production infrastructure
> (the dedicated hardened k3s cluster, OpenTofu, SOPS secrets, SSM node access,
> backups, edge, cutover) is documented in **[operations.md](operations.md)**.

## Two ways to drive this environment

The steps in this guide work by hand, and they're also wrapped by a one-command CLI:

- **Manual (this guide):** `kubectl apply -f k8s/app-dev.yaml`, `./script/mutagen.sh`, `./script/port-forward.sh`, then `kubectl exec` in. Full control, nothing hidden.
- **`collab-devcontainer` CLI (optional):** a sibling tool repo ([samg/collab-devcontainer](https://github.com/samg/collab-devcontainer)) that automates the same lifecycle — `collab-devcontainer up` builds a hardened dev image (Node 22 + Claude Code + `gh` + the isolated-vm build toolchain), applies an enhanced `app-dev` pod, sets up the Mutagen sync, installs deps, starts the port-forwards, and drops you into a shell. `collab-devcontainer doctor` validates the whole setup.

It also manages the host mounts the pod depends on — the repo's `.git` (Mutagen deliberately ignores `.git`, so this bind mount is the pod's only copy of the history) and the dirs a dragged-in screenshot can come from. Those are 9p mounts served by long-lived `minikube mount` processes, and they **do not survive a reboot or `minikube stop/start`**: the mount dies while the host process lingers, so the pod silently sees empty directories. `collab-devcontainer mounts` heals them, `collab-devcontainer mounts --install-agent` installs a LaunchAgent that keeps them healed automatically, and `up`/`shell` rebind the pod if it came up before its mounts. If in-pod `git` reports no history, that's this — not a damaged repo.

The CLI is a convenience front-end, **not a different substrate** — it deploys the same `app-dev` deployment (same name/labels/ports), produces the same `app-sync` sync to the same `/local-dev`, and reaches the same in-cluster `collab-postgres`/`collab-redis`. So the two flows are interchangeable: anything below works regardless of which you used to bring the pod up. Two differences worth knowing: the enhanced pod adds a second, secret-free `installer` container so `npm ci` runs without the DB/SES creds in scope, and because that makes the pod multi-container, the CLI **creates the `app-sync` sync itself** rather than calling `script/mutagen.sh` (the script still works for this stock single-container pod). The CLI pins `--context minikube` and refuses to run otherwise, so it can't touch a prod cluster. See the collab-devcontainer README for setup; everything in this guide remains the source of truth for what it does under the hood.

## Architecture Overview

The development setup consists of:
- **Minikube**: Local Kubernetes cluster
- **app-dev Pod**: Kubernetes pod running the development container
- **Mutagen**: Two-way file sync between your local machine and the pod
- **Port-forwarding**: Access services running in the pod from your local machine

## Prerequisites

- [Minikube](https://minikube.sigs.k8s.io/docs/start/) installed and running
- [kubectl](https://kubernetes.io/docs/tasks/tools/) configured
- [Mutagen](https://mutagen.io/documentation/introduction/installation) installed
- Docker (used by Minikube)
- [pgvector](https://github.com/pgvector/pgvector) PostgreSQL extension (for content search embeddings). Install locally with `brew install pgvector` on macOS. In Kubernetes, the `pgvector/pgvector:pg16` image is used automatically.

## Setup

### 0. Verify kubectl Context

**Before running any kubectl commands, always confirm you are targeting the minikube cluster — not a production cluster.** Deploying to the wrong context can affect live infrastructure.

```bash
# Check current context
kubectl config current-context

# Should output: minikube
# If not, switch to minikube:
kubectl config use-context minikube
```

### 1. Deploy the Development Pod

```bash
# Apply the development deployment
kubectl apply -f k8s/app-dev.yaml

# Verify the pod is running
kubectl get pods -n collab -l app=app-dev
```

### 2. Set Up Mutagen File Sync

Mutagen syncs your local code to the pod in real-time, enabling live reload during development.

```bash
# Run the mutagen setup script
./script/mutagen.sh
```

**What the script does:**
1. Switches to Minikube's Docker daemon
2. Finds the app-dev container ID
3. Creates a two-way sync between your local directory and `/local-dev` in the container
4. Installs npm dependencies in the container
5. Configures sync to ignore `node_modules/`, `.git/`, `client/dist/`, etc.

**Sync Mode:** `two-way-safe` - Changes in either direction are synced, with conflict detection

### 3. Start the Development Servers

```bash
# Connect to the pod
kubectl exec -it deployment/app-dev -n collab -- sh

# Once inside the pod, start the dev servers
cd /local-dev
npm run dev
```

This starts:
- Express backend on port 3001
- Vite frontend dev server on port 5173

## Connecting to the Dev Pod

### Interactive Shell Access

Get a shell inside the running pod:

```bash
# Using deployment name (recommended)
kubectl exec -it deployment/app-dev -n collab -- sh

# Or using pod name directly
kubectl exec -it <pod-name> -n collab -- sh
```

### Running One-off Commands

Execute commands without entering the pod:

```bash
# Check Node version
kubectl exec deployment/app-dev -n collab -- node --version

# Install dependencies
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm install"

# Run tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm test"

# Check running processes
kubectl exec deployment/app-dev -n collab -- ps aux | grep node
```

### Viewing Logs

```bash
# Stream logs from the pod
kubectl logs -f deployment/app-dev -n collab

# Get last 50 lines
kubectl logs --tail=50 deployment/app-dev -n collab
```

## Port Forwarding

To access services running in the pod from your local browser or other devices on your network:

### Quick Setup: Use the Port-Forward Script

The easiest way to set up port-forwards for both local and network access:

```bash
# Use default ports (50308 for frontend, 3001 for backend)
./script/port-forward.sh

# Or specify custom ports
./script/port-forward.sh 4567 3001
```

This script:
- Sets up port-forwards with `--address 0.0.0.0` (accessible from local network)
- Starts both frontend and backend port-forwards in the background
- Shows your local IP address for network access
- Provides process IDs for stopping the port-forwards later

### Manual Port Forwarding

#### Forward Vite Dev Server (Frontend)

**Local access only:**
```bash
# Forward local port 4567 to pod's port 5173 (Vite)
kubectl port-forward deployment/app-dev 4567:5173 -n collab
```

**Network access (for mobile testing):**
```bash
# Use --address 0.0.0.0 to allow access from other devices
kubectl port-forward deployment/app-dev --address 0.0.0.0 4567:5173 -n collab
```

Then open http://localhost:4567 in your browser.

#### Forward Express Server (Backend)

**Local access only:**
```bash
# Forward local port 3001 to pod's port 3001 (Express)
kubectl port-forward deployment/app-dev 3001:3001 -n collab
```

**Network access (for mobile testing):**
```bash
# Use --address 0.0.0.0 to allow access from other devices
kubectl port-forward deployment/app-dev --address 0.0.0.0 3001:3001 -n collab
```

#### Forward Multiple Ports

**Local access only:**
```bash
# Forward both frontend and backend
kubectl port-forward deployment/app-dev 4567:5173 3001:3001 -n collab
```

**Network access (for mobile testing):**
```bash
# Forward both with network access
kubectl port-forward deployment/app-dev --address 0.0.0.0 4567:5173 3001:3001 -n collab
```

**Note:** The Vite config is set up to work with port-forward. HMR is disabled (doesn't work reliably through the k8s tunnel), so manual page refresh is required after code changes.

### Stopping Port-Forwards

If you used the script, it will show you the process IDs. To stop:

```bash
# Stop specific processes (use PIDs shown by script)
kill <FRONTEND_PID> <BACKEND_PID>

# Or kill all port-forwards for the deployment
pkill -f 'kubectl port-forward.*app-dev'
```

### Finding Your Local IP Address

To access from other devices on your network, you'll need your local IP:

```bash
# On macOS/Linux
ifconfig | grep "inet " | grep -v 127.0.0.1

# Or use the port-forward script which shows it automatically
./script/port-forward.sh
```

## How Mutagen Sync Works

### Sync Architecture

```
┌─────────────────┐         Mutagen         ┌──────────────────────┐
│  Local Machine  │ ◄─────────────────────► │  Minikube Container  │
│  (Your Files)   │    Two-way sync         │   /local-dev/        │
└─────────────────┘                          └──────────────────────┘
```

### Sync Configuration

From `script/mutagen.sh`:

```bash
mutagen sync create . "docker://$CONTAINER_ID/local-dev" \
  --ignore=node_modules/,client/node_modules/,.git/,client/dist/,data/,log/ \
  --ignore-vcs \
  --sync-mode=two-way-safe \
  --name=app-sync
```

**Ignored Paths:**
- `node_modules/` - Dependencies (installed separately in container)
- `.git/` - Version control
- `client/dist/` - Build artifacts
- `data/`, `log/` - Runtime data

**Sync Mode:** `two-way-safe`
- Changes on your local machine → sync to container
- Changes in container → sync to local machine
- Conflicts are detected and require manual resolution

**Reliability:** In practice, Mutagen sync is almost always running and up to date. You can generally trust that local file changes are already synced to the pod without needing to verify. Only troubleshoot sync if you observe concrete evidence of stale files in the pod.

### Managing Sync

```bash
# List active syncs
mutagen sync list

# Check sync status
mutagen sync monitor app-sync

# Pause sync
mutagen sync pause app-sync

# Resume sync
mutagen sync resume app-sync

# Terminate sync
mutagen sync terminate app-sync

# Restart sync (useful if things get stuck)
mutagen sync terminate app-sync
./script/mutagen.sh
```

### Sync Troubleshooting

**Sync not working?**

```bash
# 1. Check sync status
mutagen sync list

# 2. Look for errors
mutagen sync monitor app-sync

# 3. Restart the sync
mutagen sync terminate app-sync
./script/mutagen.sh

# 4. Verify container is running
kubectl get pods -n collab -l app=app-dev
```

**Files not appearing in the pod?**

Check if the path is being ignored by the sync configuration. Mutagen ignores `node_modules/`, `.git/`, and build artifacts by default.

**Conflicts detected?**

```bash
# View conflicts
mutagen sync monitor app-sync

# Reset and re-sync
mutagen sync terminate app-sync
./script/mutagen.sh
```

## Common Development Workflows

### Workflow 1: Local Development with Live Reload

```bash
# Terminal 1: Set up sync
./script/mutagen.sh

# Terminal 2: Connect to pod and start dev servers
kubectl exec -it deployment/app-dev -n collab -- sh
cd /local-dev
npm run dev

# Terminal 3: Port-forward to access from browser
kubectl port-forward deployment/app-dev 4567:5173 -n collab

# Now edit files locally - changes sync and trigger reload automatically
```

### Workflow 2: Running Tests

```bash
# Backend tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm test"

# Frontend tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev/client && npm test"

# Integration tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run test:collab"
```

**Always run backend tests via `npm run test:server`, not bare `npx jest`.** The
script supplies `--runInBand --forceExit`, and `--forceExit` is load-bearing: a
Redis client stays connected after the suite finishes, so plain `npx jest` never
exits on its own. Interactively that looks like a hang; piped or captured (as an
agent runs it) the command blocks indefinitely and returns nothing, which reads
like a broken test run rather than a finished one. If you need to run a single
suite, keep the flags: `npx jest path/to/file.test.js --runInBand --forceExit`.
Backend tests are serial-only against one database — never run two suites
concurrently against the same `DATABASE_URL`; they delete each other's fixture
rows and fail with confusing foreign-key errors. Use a per-worktree database
(`createdb collab_test_db_<n>` + `DATABASE_URL=...`) when working in parallel.

**Backend test transform note:** the backend is CommonJS, but some AI SDK deps
(`@ai-sdk/openai-compatible` and its nested `@ai-sdk/*`, plus `@workflow/*`) ship
ESM-only. Jest handles them via a babel-jest `transform` with `@babel/preset-env`
plus a `transformIgnorePatterns` allowlist (`(?!(@ai-sdk|@workflow)/)`) in
`package.json`'s `jest` config — this transpiles those packages to CJS at test
time. Because of that, the server test scripts run WITHOUT
`--experimental-vm-modules` (that flag makes Jest load `type: module` packages as
native ESM, which bypasses the transform and breaks `require()` from our CJS). If
you add another ESM-only dependency and see "Cannot use import statement outside a
module" in tests, add its scope to the `transformIgnorePatterns` allowlist.

### Workflow 3: Installing New Dependencies

```bash
# Option A: Install locally and let Mutagen sync
npm install <package>
# Wait for sync, then restart dev server in pod

# Option B: Install directly in pod
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm install <package>"

# For frontend dependencies
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev/client && npm install <package>"
```

### Workflow 3.5: Search Evaluation Harness (feature 018)

The retrieval-quality harness lives at `server/search/eval/` and runs
on-demand in the dev pod — it is an **operator tool, never part of CI**
(it needs a live `GOOGLE_GENERATIVE_AI_API_KEY`, a populated corpus, and
it re-indexes the corpus per variant):

```bash
# Composition audit of the curated eval set (offline, no API key needed)
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run search:eval:check"

# Minimum sweep: fixed (old chunking) → structure → structure+preambles.
# Re-indexes ALL documents per variant — run it against a corpus you are
# happy to re-embed, and restore your preferred config afterwards by
# letting the sweep end on the shipping variant (it does, by default).
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run search:eval"

# Saturation-guard verdict over a results file (SC-009)
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run search:eval:check eval-results.<timestamp>.json"

# Optional flagged variants / fast iteration
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run search:eval -- --rerank"
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run search:eval -- --variant=structure-preambles --limit=10"
```

- The eval set (`server/search/eval/eval-set.json`) is versioned and
  curated by hand; `seed-eval-corpus.js` reproduces the deterministic
  sandbox corpus the committed draft set references (point `DATABASE_URL`
  at a scratch database first — never at a corpus you care about).
- Results land as `server/search/eval/eval-results.<ts>.json` (git-ignored).
- Reminder: backend Jest stays strictly serial — never run the harness and
  a backend test run against the same database at the same time.

### Workflow 4: Database Operations

```bash
# Run migrations
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run migrate"

# Connect to PostgreSQL
kubectl exec -it deployment/collab-postgres -n collab -- psql -U postgres -d collab_db

# Initialize database
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run init-db"
```

## Development Authentication Bypass

For easier development and mobile testing, the application supports bypassing Google OAuth authentication and automatically logging in with a test user.

### How to Enable

Set the `VITE_BYPASS_AUTH` environment variable to `true` in `client/.env`:

```bash
VITE_BYPASS_AUTH=true
```

### How It Works

When auth bypass is enabled:

1. **Auto-login**: The app automatically logs you in as a test user (`dev@test.local`) when you load the page
2. **No OAuth redirect**: Clicking "Login" calls the `/auth/dev-login` endpoint instead of redirecting to Google OAuth
3. **Fail-closed gating**: The `/auth/dev-login` endpoint (and the other synthetic dev endpoints) are mounted only behind the explicit positive opt-in `ENABLE_DEV_ENDPOINTS=1`, with `NODE_ENV !== 'production'` as an additional belt. Absent the flag they return `404`, independent of `NODE_ENV`. The dev/staging overlay sets the flag (`k8s/overlays/minikube/app-dev.yaml`); production never does.

### Test User Details

- **Email**: `dev@test.local`
- **Name**: `Dev Test User`
- **Google ID**: `dev-test-user`

### Use Cases

- **Mobile testing**: Test on physical devices over HTTP (where `crypto.randomUUID()` may not be available)
- **Quick iteration**: Skip OAuth flow during rapid development
- **Offline development**: Work without internet connection

### Security

The dev-login endpoint includes several safety measures:

- Mounted only behind the positive `ENABLE_DEV_ENDPOINTS=1` opt-in (plus a `NODE_ENV !== 'production'` belt); returns `404` otherwise
- Never present in the production overlay, so it cannot leak even if `NODE_ENV` is left unset
- Test user is clearly identifiable by email domain

### Disabling

To disable auth bypass and use real Google OAuth:

```bash
# In client/.env
VITE_BYPASS_AUTH=false
```

Or simply remove the environment variable.

## First-Run Test Mechanism (Feature 029)

Tooling that makes the plugin first-run flow cheap to rehearse without burning
real Google/Claude accounts or a human clicking browsers. All synthetic endpoints
below are gated by `ENABLE_DEV_ENDPOINTS=1` (fail-closed; `404` when unset,
independent of `NODE_ENV`) — the dev/staging overlay sets it. The `$DEV` base URL
in the examples is the running dev server (e.g. `http://localhost:3001` in the pod).

### Fresh-user faucet — `POST /auth/dev-login`

Extends dev-login with three modes (empty body still mints the fixed
`dev@test.local` user):

```bash
# Fresh synthetic user (JSON): mints test+<nonce>@test.local, distinct per call
curl -sX POST $DEV/auth/dev-login -H 'content-type: application/json' -d '{"fresh":true}'
#  => { accessToken, user, email:"test+<nonce>@test.local", nonce }

# Explicit nonce for a stable, re-addressable identity (reuse = re-login)
curl -sX POST $DEV/auth/dev-login -H 'content-type: application/json' -d '{"fresh":true,"nonce":"abc123"}'

# Browser mode: sets session cookies + 302 to a validated same-origin returnTo,
# standing in for Google on the consent page's sign-in leg (stamps agent_oauth
# provenance + skips the welcome doc, exactly like a real consent-born account)
curl -si -X POST $DEV/auth/dev-login -H 'content-type: application/json' \
     -d '{"fresh":true,"browser":true,"returnTo":"/authorize?client_id=..."}'
```

### Synthetic wipe — `POST /auth/dev-wipe-user`

Hard-deletes a synthetic user and everything hanging off the row (documents,
their content/versions, delegations, tokens) so the identity's next sign-in is a
genuine first run. Only ever targets the `test+<nonce>@test.local` namespace.

```bash
curl -sX POST $DEV/auth/dev-wipe-user -H 'content-type: application/json' -d '{"email":"test+abc123@test.local"}'
curl -sX POST $DEV/auth/dev-wipe-user -H 'content-type: application/json' -d '{"all":true}'   # wipe all synthetic users
# A non-synthetic address is refused (400) — real accounts are never touched.
```

### Consent auto-approve — `POST /auth/dev-consent-approve`

Completes the OAuth consent Approve step for a **synthetic session** (Bearer
token from the faucet) and mints the authorization code with no browser click.
Refuses (403) any non-synthetic session.

### Tier-2 — headless OAuth-chain driver

Walks the whole agent connect chain (401 → resource/AS metadata → dynamic client
registration → PKCE authorize → faucet sign-in → auto-approve → token exchange)
and finishes with a real authenticated MCP tool call. Single command, re-runnable
as a regression check:

```bash
node test/first-run/oauth-chain-driver.mjs --server $DEV
```

Pass `--first-run` to exercise the feature-031 single-screen collapse: a
brand-new (`user.isNew`) account signs in via the faucet's browser mode carrying
an `/authorize` returnTo, and the code is **auto-issued inline** — the chain
completes with **zero consent POSTs**, standing in for the genuine one-screen
first-run. Without the flag, the driver walks the returning-user path (explicit
`dev-consent-approve`). A returning/existing account never auto-issues: it falls
through to the consent page, which the driver asserts.

### Tier-3 — unattended in-pod rehearsal harness

One command yields a pristine first-run environment (scratch `CLAUDE_CONFIG_DIR`
+ fresh synthetic user + the plugin installed pointed at the dev server) and a
graded transcript, driving `claude -p` non-interactively:

```bash
node test/first-run/rehearsal-harness.mjs --server $DEV       # full run (needs ANTHROPIC_API_KEY)
node test/first-run/rehearsal-harness.mjs --server $DEV --no-claude   # build + grade env only
node test/first-run/state-bleed-check.mjs --server $DEV       # two runs, assert no state bleed
```

The `--bundle` default is the committed **shipping bundle**
`distribution/claude-plugin/` (feature 032) — generated from
`distribution/shared/{skill.md,onboard.md}` by `node distribution/publish.mjs`
(the single generator; dry-run by default, `--publish` to push mirrors — a Sam
op). So rehearsals exercise the real M2 coaching content, and clean passes across
the matrix are the intended outcome. `bundle-drift.test.mjs` (in
`npm run test:first-run`) asserts the committed bundle byte-matches what
`publish.mjs` regenerates, so a hand-edit fails CI. Pass `--bundle
test/first-run/stub-plugin/` to rehearse against the minimal single-marker stub
instead (the M2 `assemble-bundle.mjs` / `assembled-bundle/` /
`check-bundle-agreement.mjs` are retired — `publish.mjs` + the drift guard
replace them).

`publish.mjs` now generates **four** distribution channels from `shared/` (feature
033 added wave-2): `claude-plugin` + `mcp-registry` (wave 1) and `kiro-power` +
`cursor-plugin` (wave 2). Each has its own mirror env var (`SQUIRE_MIRROR_*`),
independent version (Kiro's rides `POWER.md` frontmatter; the others a JSON
`version`), and a drift-exempt-but-prod-pinned `mcp.json`/`.mcp.json` endpoint. The
drift guard, prod-pin, and extra-file guard run over all four channels; the
Add-to-Cursor deeplink is computed from the prod endpoint and round-trip-tested.

**Linux-pod-only**: pristine rehearsals require the Linux dev pod. On macOS,
Claude Code stores OAuth credentials in the system Keychain, which a scratch
config dir does not clear — macOS support is out of scope (not built).

### Production single-account reset — `POST /auth/prod-reset-selftest-account`

The one dev-support endpoint reachable in production. Admin-gated (`requireAdmin`),
NOT behind `ENABLE_DEV_ENDPOINTS`. It takes **no target parameter** — the target
is the hardcoded self-test account `selftest@example.com` and nothing else.
Idempotent no-op when already reset.

```bash
curl -sX POST https://squiredocs.com/auth/prod-reset-selftest-account \
  -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN"
```

## Telemetry (OpenTelemetry)

All telemetry is off by default; the app is fully inert with none of these set.

| Var | Default | Effect |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset) | Collector OTLP base URL. **Unset = inert** (no export, no noise). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | OTLP transport (http/protobuf only; no gRPC dep). |
| `OTEL_EXPORTER_OTLP_HEADERS` | (none) | Optional auth/tenant headers for the Collector. |
| `OTEL_SERVICE_NAME` | `squire-server` | `service.name` resource attribute. |
| `OTEL_RESOURCE_ATTRIBUTES` | (none) | Extra resource attributes (e.g. `deployment.environment=prod`). |

Local dev needs no Collector: leave `OTEL_EXPORTER_OTLP_ENDPOINT` unset and the
server logs structured JSON to stdout while everything else is inert. Backend
tests run Collector-less by design.

**Note on the console shim**: `console.log/info/warn/error/debug` are replaced
process-wide by a non-throwing JSON logger. Local terminal output is now JSON
lines rather than plain text; pipe through `pino-pretty` if you want a
human-readable dev view (not a dependency — install ad hoc).

## MCP API Testing

The MCP (Model Context Protocol) API allows AI agents to interact with documents. For testing the MCP endpoint locally, you need to generate a valid agent token.

### MCP Agent Token Structure

MCP agent tokens are JWTs with a specific structure:

```javascript
{
  delegationId: 'test-delegation',  // ID of the OAuth delegation
  userId: '<user-uuid>',            // User ID the agent acts on behalf of
  agentId: 'test-agent',            // Unique agent identifier
  agentName: 'Test Agent',          // Human-readable agent name
  scopes: ['documents:read', 'documents:write'],        // Granted permissions
  isAgent: true                     // Required flag
}
```

### Generating a Test Token

Create a test token using Node.js:

```bash
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({
  delegationId: 'test-delegation',
  userId: '10937127-083d-4359-b0be-6c1390878780',  // Replace with actual user ID
  agentId: 'test-agent',
  agentName: 'Test Agent',
  scopes: ['documents:read', 'documents:write'],
  isAgent: true
}, 'dev-mcp-secret-change-in-production', {
  expiresIn: '1h',
  issuer: 'collab-app-mcp'
});
console.log(token);
"
```

**Important:** The secret (`dev-mcp-secret-change-in-production`) and issuer (`collab-app-mcp`) must match what's configured in `server/mcp/auth/jwt.js`.

### Finding a User ID

To find the Dev Test User's ID from the database:

```bash
kubectl exec -it deployment/collab-postgres -n collab -- \
  psql -U postgres -d collab_db -c "SELECT id, name, email FROM users WHERE email = 'dev@test.local';"
```

### Making MCP API Requests

**Note:** When running locally with `npm run dev`, the server port may vary (e.g., `59178` instead of `3001`). Check your terminal output or browser URL for the actual port. The examples below use `3001` but substitute your actual port.

Save a test token to a file for easier testing:

```bash
node -e "
const jwt = require('jsonwebtoken');
const token = jwt.sign({
  delegationId: 'test-delegation',
  userId: 'YOUR-USER-ID-HERE',
  agentId: 'test-agent',
  agentName: 'Test Agent',
  scopes: ['documents:read', 'documents:write'],
  isAgent: true
}, 'dev-mcp-secret-change-in-production', {
  expiresIn: '1h',
  issuer: 'collab-app-mcp'
});
const fs = require('fs');
fs.writeFileSync('/tmp/mcp-token.txt', token);
console.log('Token saved to /tmp/mcp-token.txt');
"
```

Then make requests:

```bash
# List available tools
TOKEN=$(cat /tmp/mcp-token.txt)
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .
```

### Example: Testing XPath Queries

The `modify` tool supports XPath queries for selecting document elements. Here's how to test it:

```bash
# Create test request file
cat > /tmp/xpath-test.json << 'EOF'
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "modify",
    "arguments": {
      "docGuid": "YOUR-DOC-GUID-HERE",
      "script": "export default function edit(doc) {\n  const headings = xpath('//heading');\n  console.log('Found', headings.length, 'headings');\n}"
    }
  }
}
EOF

# Execute the request
TOKEN=$(cat /tmp/mcp-token.txt)
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @/tmp/xpath-test.json | jq .
```

### Common XPath Test Queries

```javascript
// Find all headings
xpath('//heading')

// Find level-2 headings
xpath('//heading[@level=2]')

// Find paragraphs containing "TODO"
xpath('//paragraph[contains(., "TODO")]')

// Find all paragraphs
xpath('//paragraph')

// Find first heading
xpathFirst('//heading[@level=1]')
```

### Reading Documents

```bash
cat > /tmp/read-doc.json << 'EOF'
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "read_document",
    "arguments": {
      "docGuid": "YOUR-DOC-GUID-HERE"
    }
  }
}
EOF

TOKEN=$(cat /tmp/mcp-token.txt)
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d @/tmp/read-doc.json | jq .
```

### Listing Documents

```bash
TOKEN=$(cat /tmp/mcp-token.txt)
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_documents","arguments":{}}}' | jq .
```

### Alternative: Using API Tokens

Instead of generating JWT tokens manually, you can create personal API tokens from the Settings page in the app. These `sqd_`-prefixed tokens are simpler for testing:

1. Log in to the app and go to Settings
2. Under "API Tokens", create a new token
3. Copy the token (it's only shown once)
4. Use it as a Bearer token:

```bash
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sqd_YOUR_TOKEN_HERE" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq .
```

### Debugging Tips

1. **Token validation errors**: Ensure the secret and issuer match `server/mcp/auth/jwt.js`
2. **User not found**: The `userId` in the token must exist in the database
3. **Permission denied**: Check that `scopes` includes the required permissions (`documents:read`, `documents:write`)
4. **Document not found**: Verify the `docGuid` exists and the user has access

### Visual Testing with Agent Presence

When testing XPath queries, the agent's cursor/selection will be broadcast to connected clients. To see the visual highlighting:

1. Open the document in a browser (logged in as the same user)
2. Run the MCP query from the command line
3. Watch the editor - you'll see highlights animate through matched elements

The highlighting behavior:
- Each matched element highlights sequentially (80-240ms random delay between each)
- The final element stays highlighted for 10 seconds
- Mutations during script execution clear any pending highlights

## Mobile Testing on Local Network

To test the application on a mobile device connected to the same local network:

### 1. Set Up Port-Forward for Network Access

**Recommended: Use the port-forward script:**

```bash
./script/port-forward.sh
```

This automatically sets up both frontend and backend port-forwards with network access enabled.

**Manual setup:**

Use the `--address 0.0.0.0` flag to bind port-forward to all network interfaces:

```bash
# Forward frontend (default port 50308)
kubectl port-forward deployment/app-dev --address 0.0.0.0 50308:5173 -n collab

# Forward backend (default port 3001)
kubectl port-forward deployment/app-dev --address 0.0.0.0 3001:3001 -n collab
```

This makes the app accessible from any device on your local network.

### 2. Find Your Local IP Address

The port-forward script automatically shows your local IP. Or find it manually:

```bash
# On macOS/Linux
ifconfig | grep "inet " | grep -v 127.0.0.1
```

### 3. Access from Mobile

Open your mobile browser and navigate to:

```
http://YOUR_LOCAL_IP:FRONTEND_PORT
```

For example, if your local IP is `192.168.50.122` and you're using port `50308`:
```
http://192.168.50.122:50308
```

The port-forward script will display the exact URL to use.

### 4. Enable Auth Bypass

Since mobile devices accessing via HTTP (not HTTPS) may have limited Web Crypto API support, enable auth bypass in `client/.env`:

```bash
VITE_BYPASS_AUTH=true
```

This bypasses OAuth and automatically logs you in for testing.

### Troubleshooting Mobile Testing

**Firewall Issues**
- Ensure your Mac's firewall allows incoming connections on the forwarded port
- Check System Settings > Network > Firewall

**Same Network Required**
- Mobile device and development machine must be on the same Wi-Fi network

**UUID Generation**
- The app includes a fallback UUID generator for non-secure contexts (HTTP)
- `crypto.randomUUID()` requires HTTPS, so we fall back to `Math.random()` over HTTP

**Hot Module Reload (HMR)**
- HMR is disabled (doesn't work reliably through the k8s tunnel)
- Manually refresh the page after making changes

## Testing the Onboarding / Welcome Flow

The welcome flow (see the README's "Onboarding / Welcome Flow" section) only fires
for users who are *not yet engaged* (own no doc, other than their welcome doc,
that has content). A dev account that has been used will already be "engaged," so
logging in normally just lands on `/docs`. Two ways to re-trigger it on demand:

**1. Client-only (greeting UX, zero setup):** append `?welcome=1` to any document
URL, e.g. `/d/<any-doc-guid>?welcome=1`. This opens the AI panel and has the
assistant greet you (scoped to that doc). It does *not* exercise seeding or the
login redirect — it's the fastest way to iterate on the greeting itself.

**2. Full flow (seed + redirect + greeting):** call the dev-only reset endpoint,
which wipes your onboarding state, deletes the old welcome doc, reseeds a fresh
one, and returns its URL. Then open that URL.

```bash
# Log in (dev bypass) to get a token, then reset onboarding and open the URL it returns.
TOKEN=$(curl -s -X POST http://localhost:3001/auth/dev-login | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
curl -s -X POST http://localhost:3001/auth/dev-onboarding-reset \
  -H "Authorization: Bearer $TOKEN"
# → {"welcomeDocId":"<guid>","url":"/d/<guid>?welcome=1"}  — open that url in the app
```

Both the `?welcome=1` trigger and `POST /auth/dev-onboarding-reset` are gated to
`NODE_ENV !== 'production'`. The reset endpoint acts on the authenticated user, so
it works for both dev-bypass and real OAuth sessions in development.

## Vite Configuration for Port-Forward

The `client/vite.config.js` is configured to work with kubectl port-forward:

```javascript
server: {
  host: process.env.VITE_HOST || '0.0.0.0',  // Bind to all interfaces
  port: 5173,                    // Internal port
  strictPort: false,             // Allow fallback if port busy
  hmr: false,                    // Disabled — doesn't work through k8s tunnel
  proxy: {
    '^/s($|/)': {                // WebSocket proxy (regex to avoid matching /src)
      target: 'ws://localhost:3001',
      ws: true,
      changeOrigin: true
    },
    '/api': {                    // REST API proxy
      target: 'http://localhost:3001',
      changeOrigin: true
    },
    '^/auth/': {                 // Auth routes proxy
      target: 'http://localhost:3001',
      changeOrigin: true
    },
    '/mcp': {                    // MCP endpoint proxy
      target: 'http://localhost:3001',
      changeOrigin: true
    },
    '/oauth-callback': {         // OAuth callback proxy
      target: 'http://localhost:3001',
      changeOrigin: true
    }
  }
}
```

**Key Points:**
- `host: '0.0.0.0'` - Allows external connections (required for port-forward)
- `hmr: false` - HMR disabled; manual page refresh required after code changes
- `'^/s($|/)'` - Regex pattern to proxy only `/s` or `/s/*` (not `/src`)
- All API, auth, MCP, and OAuth routes are proxied to the Express backend

## Troubleshooting

### Pod Not Starting

```bash
# Check pod status
kubectl get pods -n collab -l app=app-dev

# View pod events
kubectl describe pod -l app=app-dev -n collab

# Check logs
kubectl logs deployment/app-dev -n collab
```

### Port Conflicts

If you get "address already in use" errors:

```bash
# Connect to pod
kubectl exec -it deployment/app-dev -n collab -- sh

# Find processes using ports
netstat -tlnp | grep -E '(3001|5173)'

# Kill stuck processes
pkill -f node

# Restart dev servers
npm run dev
```

### Mutagen Container ID Changed

After redeploying or pod restart, the container ID changes:

```bash
# Terminate old sync
mutagen sync terminate app-sync

# Re-run setup script
./script/mutagen.sh
```

### Vite MIME Type Errors

If you see "disallowed MIME type" errors:

1. Check the proxy configuration in `client/vite.config.js`
2. Ensure the regex pattern is `'^/s($|/)'` (not just `'/s'`)
3. Restart the Vite server in the pod:
   ```bash
   kubectl exec deployment/app-dev -n collab -- pkill -f vite
   # Then restart npm run dev
   ```

### WebSocket Connection Issues

If the editor shows "Disconnected":

1. Verify port-forward is running for both ports (3001 and 5173)
2. Check that Express server is running on port 3001
3. Verify the proxy configuration in Vite config
4. Check browser console for WebSocket errors

### Files Not Syncing

```bash
# Check sync status
mutagen sync list
mutagen sync monitor app-sync

# Verify container is accessible
docker ps | grep app-dev

# Restart sync
mutagen sync terminate app-sync
./script/mutagen.sh
```

## Best Practices

1. **Always use the deployment name** in kubectl commands (not pod name) - pod names change on restart
2. **Keep Mutagen sync running** while developing - it's the bridge between your local files and the pod
3. **Install dependencies in the pod** after sync is set up - don't sync node_modules
4. **Use port-forward** for accessing services - don't expose LoadBalancer in dev
5. **Monitor sync status** if files aren't updating - `mutagen sync monitor app-sync`
6. **Restart dev servers** after config changes - Vite and Express don't always hot-reload config

## Useful Commands Reference

```bash
# === Pod Management ===
kubectl get pods -n collab                                    # List all pods
kubectl exec -it deployment/app-dev -n collab -- sh          # Enter pod shell
kubectl logs -f deployment/app-dev -n collab                 # Stream logs
kubectl describe pod -l app=app-dev -n collab                # Pod details

# === Mutagen ===
mutagen sync list                                             # List syncs
mutagen sync monitor app-sync                                 # Watch sync status
mutagen sync terminate app-sync                               # Stop sync
./script/mutagen.sh                                           # Setup sync

# === Port Forwarding ===
./script/port-forward.sh                                      # Quick setup (network access)
kubectl port-forward deployment/app-dev 4567:5173 -n collab  # Forward Vite (local only)
kubectl port-forward deployment/app-dev 3001:3001 -n collab  # Forward Express (local only)
kubectl port-forward deployment/app-dev --address 0.0.0.0 50308:5173 3001:3001 -n collab  # Network access
pkill -f 'kubectl port-forward.*app-dev'                     # Stop all port-forwards

# === Development ===
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run dev"      # Start servers
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm test"         # Run tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run migrate"  # Migrate DB
kubectl exec deployment/app-dev -n collab -- pkill -f node                             # Kill processes
```

## Database Backups

Database backups are a **production** concern, not a local-dev one — the Minikube
environment does not run the backup CronJob. The full backup and restore
operations for the production cluster (bucket hardening, the AWS-CLI-v2 uploader,
the scoped writer credential, the freshness alarm, and the rehearsed restore
procedure) are documented in **[operations.md](operations.md#backups--data-protection)**.

Quick summary of the production pipeline (see operations.md for detail):

- A nightly Kubernetes CronJob (`postgres-backup`, `k8s/base/postgres-backup-cronjob.yaml`
  + the aws-prod backup-hardening patch) runs `script/backup-postgres.sh`.
- It uploads a timestamped `pg_dump` to the dedicated, Object-Locked
  `s3://squiredocs-db-backups/` bucket, non-root, from a pinned image.

To inspect or trigger it against a cluster:

```bash
kubectl get cronjob -n collab
kubectl get jobs -n collab -l app=postgresbackup
kubectl create job --from=cronjob/postgres-backup manual-backup-$(date +%s) -n collab
```

### Restoring a backup locally (Minikube)

To seed a local Minikube Postgres from a production dump, stream it straight into
the pod:

```bash
gunzip -c collab-backup.sql.gz \
  | kubectl exec -i deployment/collab-postgres -n collab -- psql -U postgres -d collab_db
```

## Document Image Storage (S3)

Documents can embed images. Bytes are stored in a **dedicated S3 bucket** (separate
from the DB-backup bucket); the document itself only stores a short app URL
(`/api/docs/:docId/images/:imageId`). The server resolves that to a short-lived
presigned GET URL on read, so bytes never sit in the Yjs update log and never
traverse the app on the hot path. See `server/s3-images.js` and
`server/document-images.js`.

This feature is **optional** — if the S3 config is absent, image uploads return
503 and everything else works normally (`s3Images.isEnabled()` gates it).

### Configuration

Set four env vars (locally in `.env`, in-cluster via the `s3-images-secret`):

```
S3_IMAGE_BUCKET=squiredocs-images-dev
S3_IMAGE_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

The IAM credentials need `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` on
`arn:aws:s3:::<bucket>/*`. Use a dedicated bucket + IAM user — do **not** reuse the
DB-backup credentials.

For the cluster, copy `k8s/s3-images-secret.yaml.example` to
`k8s/s3-images-secret.yaml` (gitignored) and fill it in. `script/deploy-aws.sh`
applies it when present; `k8s/app-deployment.yaml` and `k8s/app-dev.yaml` reference
it with `optional: true`.

### Migration

The image metadata table is created by `migrations/1786000000000_create-document-images.js`:

```bash
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run migrate"
```

### Constraints

- Allowed types: PNG, JPEG, GIF, WebP (SVG is excluded — script-injection surface).
- Max size: 15 MB per image (mirrors the AI chat attachment limit).
- Uploading requires **editor** access; viewing requires **viewer** access.
- Deleting a document deletes its image rows (CASCADE) and its S3 objects.

## Next Steps

- See [README.md](../README.md) for application features and usage
- See [plan.md](./plan.md) for project roadmap and architecture
- See [phase1.md](./phase1.md) for current phase implementation details





