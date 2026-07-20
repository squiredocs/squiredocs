# Collaborative Rich Text Editor

A real-time collaborative rich text editor built with Yjs, TipTap, and Node.js. Multiple users can edit the same document simultaneously with automatic conflict resolution.

## Features

- **Real-time Collaboration**: Multiple users can edit simultaneously with changes appearing in real-time
- **In-App AI Assistant**: Built-in chat panel powered by Claude for editing, searching, and managing documents via natural language
- **Chat-Centric Mode**: Full-page chat interface (`/chat`) with conversation history sidebar and optional document side pane — toggle between document-centric and chat-centric layouts via the view-switch button in the header
- **AI Agent Integration**: Model Context Protocol (MCP) support for AI-powered document editing from external agents like Claude Code, Kiro, and Claude Desktop
- **Markdown Export**: Export any document you can view as a Markdown (`.md`) file from the editor's tools menu (uses the same Yjs→Markdown serializer that powers version-history diffs). The REST route supports repo-friendly options: `flavor=portable` degrades HTML-only marks for clean GitHub rendering (underline→emphasis, highlight→bold, styled spans→plain text — declared per mark in the format registry), `frontmatter=true` prepends a self-describing `squire:` YAML block (docGuid, title, clock, exportedAt, lastModifiedBy, flavor, lossy list), and `format=bundle` downloads a zip with image assets under `assets/<docSlug>/` and references rewritten to relative paths (bundle defaults: portable + frontmatter, both overridable). The route defaults to portable flavor (repo-friendly); pass `flavor=squire` for the full-fidelity dialect, which remains the internal canonical form. Task lists export as GFM `- [ ]`/`- [x]` and hard line breaks as trailing backslashes in every flavor
- **Markdown Import**: Push markdown *into* Squire — create a fully populated document in one call (`create_document({ markdown })` or `POST /api/docs/import`), append or replace an existing document over REST (`PUT /api/docs/:docId/import`), or convert markdown to blocks inside a `modify` script with the `fromMarkdown()` sandbox helper. All surfaces share one import module; external images are fetched and rehosted server-side under an SSRF-safe policy, link hrefs are protocol-allowlisted, and a leading `squire:` frontmatter block is consumed defensively. See [Markdown Import Surfaces](#markdown-import-surfaces).
- **Document Permissions**: Role-based access control (Owner, Editor, Viewer) with granular sharing
- **Rich Text Formatting**: Bold, italic, underline, strikethrough, headings (H1-H3), lists, interactive task lists (GFM checklists — checkbox toggles are collaborative, attributed edits), and code snippets
- **Diagram Blocks**: Insert **Mermaid** (`◇`) diagram-as-code blocks or raw **SVG** (`⬡`) blocks from the toolbar that render live as you type. SVG blocks are sanitized at render time (DOMPurify with a strict policy — no scripts, event handlers, `foreignObject`, or external references; see `shared/svg-sanitizer.mjs`) so agent- or collaborator-authored markup can't execute script or phone home. Copying a diagram places a rasterized PNG on the clipboard so it pastes as an image into Google Docs/Notion, and the source round-trips back into an editable block on paste. Diagrams serialize to fenced code blocks (` ```mermaid `, ` ```svg `) for Markdown export and AI-agent editing.
- **Images in Documents**: Insert images (PNG, JPEG, GIF, WebP; 15 MB max) via the toolbar picker (`🖼`), drag-and-drop, or paste (e.g. a screenshot). Bytes are stored in a dedicated S3 bucket; the document holds only a short app URL (resolved to a short-lived presigned URL on view), so the Yjs update log stays small. Images serialize to `![alt](url)` for Markdown export and AI-agent editing. Optional — requires S3 config (see [docs/dev.md](docs/dev.md#document-image-storage-s3)); uploads are disabled if unset.
- **Version History**: View, name, filter, and restore previous versions with markdown-based diff highlighting (including word-level emphasis inside changed lines) and formatting-change detection
- **Add Selection to Chat**: Select any text in a document and click the floating **"Add to Chat"** tag to attach that passage to the AI chat input as a removable reference chip — labeled with the document it came from — then ask about it without describing where it is. Works on desktop and mobile, and you can stack several selections (even from different documents) before sending
- **Image Upload in Chat**: Attach up to 5 images per message (PNG, JPEG, GIF, WebP; 15 MB per file) via drag-and-drop or file picker; dropped `.md` files attach too, and the assistant imports them into new documents via the `import_markdown` tool (content bypasses the model)
- **Inline Diffs in Chat**: AI edits via the `modify` tool (and undo/redo) display color-coded inline diffs directly in chat messages, with the changed words within a line emphasized GitHub-style
- **Bring Your Own Key (BYOK)**: Users can supply their own Anthropic, Google, OpenAI, z.ai, or OpenRouter API keys from the Settings page to use premium models without consuming shared credits
- **Settings Page**: Manage authorized AI agents, MCP API tokens, and BYOK API keys
- **Appearance (Light / Dark / System)**: A theme control in the user profile menu offers **Light**, **Dark**, or **System** (the default, which follows the OS `prefers-color-scheme` live). The choice is saved per device (localStorage, key `squire-theme`) and applied before first paint, so there is no flash of the wrong theme on load — on every screen, signed in or out. Both the app chrome and the document canvas theme dark; author-set text/background colors render exactly as authored in both themes, Mermaid/SVG diagrams render on a light "media plate", and printing is always light. Color is centralized in a semantic token layer in `client/src/index.css` (light + dark realizations); a `lint:colors` gate (`cd client && npm run lint:colors`, also a Vitest test) keeps every themed surface literal-free
- **Get Support**: A "Get Support" item in the user menu opens a dedicated page (`/support`) where users describe an issue and review their previous requests; submissions are saved to the `support_requests` table and emailed to the admin (reply-to set to the user)
- **Product Documentation Site**: Public pages under `/documentation` (no sign-in required) documenting the product across twelve pages. Sources are markdown files under `documentation/` at the repo root, rendered to static HTML during the client build (`client/scripts/build-documentation.mjs` + `render-documentation.mjs`, markdown-it with `html:false`) and served like the marketing pages (explicit Express routes + a Vite dev middleware that renders on refresh). Terminology standard: "docs"/"documents" mean Squire documents; "documentation" means material about the product — never "docs". Reachable from the marketing header/footer and a "Documentation" item in the user menu. Design ground truth: `design/product-documentation-site.md`; user-facing feature descriptions belong on the documentation site, and this README narrows toward developer and operator material over time
- **Onboarding / Welcome Flow**: On login, a not-yet-"engaged" user lands on their own seeded "Welcome to Squire Docs" document with the AI assistant panel open and the assistant proactively greeting them and offering to research a topic. See [Onboarding / Welcome Flow](#onboarding--welcome-flow).
- **Offline Support**: Edit while disconnected, changes sync automatically when connection is restored
- **User Presence**: See who's online and their cursor positions
- **Conflict-free**: Automatic conflict resolution using Yjs CRDT technology
- **Document Management**: Create, share, and delete documents with permission enforcement
- **Near-Realtime Document List**: Document list polls for updates every 5 seconds and on tab visibility change
- **Full-Text & Semantic Search**: Search box on the document list searches document *contents* using hybrid search — PostgreSQL full-text (`tsvector`) combined with pgvector semantic/embedding search, fused via Reciprocal Rank Fusion. Content searches accept an optional `updatedAfter` recency filter (REST `GET /api/docs?searchMode=content` and MCP `list_documents`) applied inside each engine before ranking, so results and totals reflect only recently updated documents. Indexing is structure-aware: documents split along heading boundaries into ~600-token chunks (`server/search/chunker.js`), each carrying its `heading_path`, and every chunk's embedded text leads with `title > h1 > … > hN` so titles are semantically searchable. Multi-chunk documents additionally get short LLM-generated contextual preambles (`server/search/contextualizer.js`, Gemini 2.5 Flash via the provider registry) that are embedded AND keyword-indexed with the chunk — single-chunk documents get none, and preamble failures never block indexing. Search snippets always come from document-authored text, never generated preambles. The indexer is incremental: a content hash of the title + extracted body text gates embedding regeneration (formatting churn costs zero provider calls; a title change re-embeds because the title is part of the embedded text), and each chunk row records the embedding model that produced it so boot repair automatically re-embeds documents after a model upgrade (and re-chunks any remaining pre-018 fixed-window rows). Retrieval quality is measured by a first-class eval harness (`npm run search:eval` — see `server/search/eval/`); an optional LLM reranker exists behind `SEARCH_RERANK` and is **off by default** (a prior eval showed it lowered MRR at ~5.7 s/query)
- **Admin Area**: Admin dashboard for viewing user stats (docs, AI usage, last login), granting extra AI credits, marking users "trusted" to enable outbound share email, sending the beta welcome email to a user on demand (per-row button; never automatic; admin is BCC'd), reviewing a user's sharing activity (invites sent, collaborators on owned docs), setting the shared assistant's default AI model, and email notifications (sign-up, login, credit-limit, support requests, exceptions)

## Technology Stack

- **Frontend**: React 18, TipTap, Yjs
- **Backend**: Node.js, Express, WebSocket (y-websocket)
- **Persistence**: PostgreSQL for server-side storage, IndexedDB for client-side offline support
- **Authentication**: Google OAuth with JWT (access and refresh tokens)
- **Database**: PostgreSQL with node-pg-migrate for schema management
- **Caching**: Redis for session and state management
- **Sandbox**: isolated-vm (true V8 isolate with 128 MB memory limit) for secure script execution in the `modify` tool
- **AI Integration**: In-app assistant via AI SDK v6 (Claude Haiku 4.5, Sonnet 4.6, and Opus 4.8; Gemini 2.5 Flash/Pro; Gemini 3 Flash, Gemini 3.1 Pro, and Gemini 3.5 Flash; OpenAI GPT-5.5 / GPT-5.4 / GPT-5.4 mini via BYOK; z.ai GLM-4.6 / GLM-4.7 / GLM-5 / GLM-5.2 via BYOK; the same GLM models via the OpenRouter gateway via BYOK); Model Context Protocol (MCP) with OAuth 2.0 or API tokens for external AI agents. Per-provider behavior (model dispatch, key validation, web search, prompt caching) is defined in one place, `server/api/ai-providers.js`

## Prerequisites

- Node.js 22+ (required by isolated-vm)
- npm or yarn
- PostgreSQL 12+ (for server-side persistence)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd collaborative-editor
```

2. Install root dependencies:
```bash
npm install
```

3. Install client dependencies:
```bash
cd client
npm install
cd ..
```

4. Set up PostgreSQL database:
   - Make sure PostgreSQL is installed and running
   - Create the database (if it doesn't exist):
     ```bash
     createdb collab_db
     ```
     Or using psql:
     ```bash
     psql -U postgres -c "CREATE DATABASE collab_db;"
     ```
   - Run migrations:
     ```bash
     npm run migrate
     ```
   
   **Optional convenience script:** If you want to automatically create the database and run migrations:
     ```bash
     npm run init-db
     ```

## Development

To run both the server and client in development mode:

```bash
npm run dev
```

This will start:
- Backend server on `http://localhost:3001`
- Frontend dev server on `http://localhost:5173`

Open `http://localhost:5173` in your browser to use the editor.

> **Sandbox option:** the Minikube + Mutagen dev environment can be driven by a one-command CLI, [samg/collab-devcontainer](https://github.com/samg/collab-devcontainer), which runs the `app-dev` pod from a hardened dev image (Node 22 + Claude Code + `gh` + build tools). It's a convenience front-end over the same substrate documented in [docs/dev.md](docs/dev.md), not a replacement.

### Project Status & Workflow

This is a **single-developer personal project**, so it deliberately skips the ceremony of a team workflow. There is **no pull-request or code-review process** — ordinary changes are committed straight to `main` and deployed to prod from there (see [Deploy Scripts](#deploy-scripts)). Branches are used only when they earn it: exploratory spikes, larger multi-step efforts, or work risky enough to want isolated until it's ready. **Default path for a normal change: run the tests, commit to `main`, deploy.**

Larger, design-driven efforts follow the **design pipeline** (`.claude/skills/the-pipeline/SKILL.md`): design docs are authored collaboratively in Squire itself (dogfooding), exported to `design/` via `node design/sync.mjs` as ground truth, then spec-kit agents spec/plan/implement in parallel worktrees with a serial merge queue and post-merge review. The project constitution lives at `.specify/memory/constitution.md`.

### Running Separately

**Backend only:**
```bash
npm run server
```

**Frontend only:**
```bash
npm run client
```

## Production Build

1. Build the frontend:
```bash
npm run build
```

2. Start the production server:
```bash
npm start
```

The server will serve the built frontend from `client/dist` and handle WebSocket connections.

`npm run build` also renders two static markdown-driven sites into `client/dist`:

- **Documentation** (`/documentation`): sources in `documentation/*.md`, rendered by
  `client/scripts/build-documentation.mjs`, served by `server/documentation-routes.js`.
- **Blog** (`/blog`): sources in `blog/*.md`, rendered by `client/scripts/build-blog.mjs`,
  served by `server/blog-routes.js`. Each post is a markdown file with `slug`, `title`,
  `description`, `date`, and `author` frontmatter; the index lists posts newest-first.

Both reuse the shared marketing header/footer chrome (`marketing.css`) and are served in dev
by Vite middleware (`client/vite.config.js`), so a content edit shows on refresh with no build.

## Kubernetes Deployment

Production runs on AWS k3s in the `collab` namespace, served through CloudFront
`<cloudfront-distribution-id>` (which terminates TLS for `squiredocs.com` and reaches the
`app.squiredocs.com` origin). Since the 2026-07-16 cutover it runs on a
**dedicated hardened single-node k3s cluster** that is Squire's alone:

- **Production** is the dedicated cluster (kube context `k3s-squiredocs`, node
  `<prod-instance-id>`, EIP `<prod-eip>`) — its own EC2 instance, security group,
  and IAM role. It is declared as code with **OpenTofu** (`infra/terraform/`),
  **Kustomize** (`k8s/base` + `k8s/overlays/{minikube,aws-prod}`), and **SOPS/age**
  secrets (`k8s/secrets/`). Origin TLS is a cert-manager + Let's Encrypt (Route53
  DNS-01) certificate that auto-renews.
- **The old shared node** (context `k3s-wft-aws`, `<old-node-ip>`), which shared its
  EC2 instance, SG, and IAM role with the wildfiretrackers.com workload, is now
  **orphaned** and awaits decommissioning.

**The full operator guide is [docs/operations.md](docs/operations.md)** — cluster
topology, OpenTofu/state, Kustomize, SOPS secrets, SSM node access, the ECR
pull-secret refresh, the backup pipeline, edge/CloudFront, the cutover procedure,
observability, and the gotchas. Design ground truth is
[design/infrastructure-and-environments.md](design/infrastructure-and-environments.md);
the migration runbook is
[specs/011-iac-config-management/runbook.md](specs/011-iac-config-management/runbook.md).

Local development uses **Minikube** — see [docs/dev.md](docs/dev.md).

### Minikube Setup (local development)

```bash
# 1. Start minikube with sufficient resources
minikube start --cpus=10 --memory=12288 --disk-size=40g --driver=docker

# 2. Create storage classes and label nodes
./script/setup-minikube.sh

# 3. Deploy PostgreSQL
./script/postgres-deploy.sh

# 4. Build the app image in minikube's Docker context
./script/builddockerdev.sh

# 5. Deploy the application (Redis, secrets, app, etc.)
./script/deploy.sh
```

### Seeding from a Production Backup

Nightly Postgres backups land in the dedicated `s3://squiredocs-db-backups/`
bucket (SSE-KMS + Object Lock, timestamped filenames). To restore a backup into a
cluster's Postgres pod, stream it in:

```bash
gunzip -c collab-backup.sql.gz \
  | kubectl exec -i deploy/collab-postgres -n collab -- psql -U postgres -d collab_db
```

For the dedicated cluster (no SSH; managed via SSM), relay the `.sql.gz` to the
node through a presigned S3 URL first. The complete, rehearsed restore procedure is
in [docs/operations.md](docs/operations.md#restore-procedure-rehearsed).

> Historical note: the old shared node backed up to the shared `earthquaketracksql`
> bucket with day-of-year filenames — superseded by `squiredocs-db-backups`.

### Deploy Scripts

| Script | Purpose |
|--------|---------|
| `script/setup-minikube.sh` | Creates storage classes and labels minikube nodes (local dev) |
| `script/postgres-deploy.sh` | Deploys PostgreSQL (secret, PVC, deployment, service) for minikube |
| `script/builddockerdev.sh` | Builds the Docker image in minikube's Docker context |
| `script/deploy.sh` | Legacy shared-node/GKE deploy (`envsubst`-based; kept for the rollback window) |
| `script/backup-postgres.sh` | pg_dump backup script baked into the backup image and run by the CronJob |
| **`script/build-and-deploy-aws.sh`** | **One-command production build + deploy** — ECR login, builds & pushes the arm64 image for HEAD, switches context, then runs `deploy-aws.sh`. ⚠️ Still hardcodes the legacy `k3s-wft-aws` context; see the note below. |
| **`script/deploy-aws.sh`** | **Production deploy via Kustomize** — guards the kube context (`DEPLOY_CONTEXT`, default `k3s-squiredocs`), resolves the app's ECR digest (fails closed), applies the `aws-prod` overlay, gates on the rollout + migrate Job, then tags the deploy. Secrets are applied separately via SOPS. |

### AWS k3s Deployment (production)

```bash
# Apply the SOPS secrets once, then deploy (run on an ARM Mac — the image is arm64).
for f in k8s/secrets/*.enc.yaml; do sops -d "$f" | kubectl apply -f -; done
./script/deploy-aws.sh
```

> **Known inconsistency:** `build-and-deploy-aws.sh` still hardcodes
> `CONTEXT="k3s-wft-aws"` (the legacy shared-node context) and switches to it
> before calling `deploy-aws.sh`, whose guard expects `k3s-squiredocs`. The two
> disagree, so the wrapper **fails closed** on the context guard (no wrong-cluster
> deploy) but is unusable against the new cluster as written — set `DEPLOY_CONTEXT`
> / point it at `k3s-squiredocs`, or build+push manually and run `deploy-aws.sh`
> directly. See [docs/operations.md](docs/operations.md#deploy-tooling).

> **Note:** CI (`.github/workflows/test.yml`) only runs the server and client tests — it does **not** build or push any image. So a production deploy always needs a local build+push. `deploy-aws.sh` resolves the app image's ECR digest from the pushed tag and fails if it's missing (no mutable-tag fallback).

### Notes

- `deploy.sh` does **not** deploy PostgreSQL — run `postgres-deploy.sh` first (minikube only)
- For minikube, the app image is `collab:latest` (built locally); for k3s production it pulls from ECR (`<aws-account-id>.dkr.ecr.us-east-1.amazonaws.com/eqt/collab`), arm64 only, pinned by digest at deploy time
- The dedicated cluster shares no infrastructure with the wft workload — it has its own node, security group, IAM role, postgres + redis pods
- See `docs/dev.md` for the full development environment guide (Mutagen sync, port-forwarding, etc.). Mutagen sync is almost always running and reliable — you can generally trust local changes are synced to the pod without verification.

## Configuration

### Environment Variables

- `PORT`: Server port (default: 3001)
- `DATABASE_URL`: PostgreSQL connection string (alternative to individual DB config)
- `DB_HOST`: PostgreSQL host (default: `localhost`)
- `DB_PORT`: PostgreSQL port (default: `5432`)
- `DB_NAME`: Database name (default: `collab_db`)
- `DB_USER`: Database user (default: `postgres`)
- `DB_PASSWORD`: Database password (default: `postgres`)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google OAuth credentials for user sign-in (required)
- `GOOGLE_REDIRECT_URI`: OAuth callback URL for Google sign-in
- `JWT_SECRET`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`: Secrets for signing user session JWTs
- `API_KEY_ENCRYPTION_KEY`: The "legacy" AES-256-GCM key used to encrypt stored BYOK API keys at rest (64-char hex = 32 bytes). Decrypts all untagged (pre-rotation) values and is the default encryption key. Required in production.
- `API_KEY_ENCRYPTION_KEYS` / `API_KEY_ENCRYPTION_PRIMARY`: Optional keyring for **rotating** the BYOK encryption key without invalidating stored keys. `API_KEY_ENCRYPTION_KEYS` is a comma-separated list of `id:hex` entries (e.g. `2:<64hex>`); `API_KEY_ENCRYPTION_PRIMARY` names the id used to encrypt new values (defaults to `legacy`, which keeps the byte-identical untagged format). Stored values encrypted under a non-legacy key are tagged `k<id>:…`. Because the app runs multiple replicas under a rolling deploy, rotation is a **two-phase** process (a single-deploy flip would leave old pods unable to decrypt new pods' writes): **(1) distribute** — add the new key to `API_KEY_ENCRYPTION_KEYS` on all pods with `API_KEY_ENCRYPTION_PRIMARY` still `legacy`, deploy, and wait for the rollout to complete so every pod can decrypt it; **(2) promote** — set `API_KEY_ENCRYPTION_PRIMARY` to the new id and deploy. Then run `node script/reencrypt-byok-keys.js` to migrate stored values, `--verify` to gate (it decrypts every value and exits non-zero if any is stale or undecryptable), and only once verify is clean remove the old key. Run the script and `--verify` **with the serving pods' environment** (e.g. `kubectl exec` into a pod), not a local `.env` with hand-typed keys. See `server/crypto.js` and `script/reencrypt-byok-keys.js`.
- `CLIENT_URL`: Base URL of the frontend (used to build absolute links in emails and redirects)
- `REDIS_HOST` / `REDIS_PORT`: Redis connection (defaults: `localhost` / `6379`)
- `AGENT_CLAIM_TTL_MS`: Lifetime of the cluster-wide agent presence claim in ms (default: `15000`). Bounds the worst-case avatar gap after a claim-holding instance crashes.
- `AGENT_CLAIM_HEARTBEAT_MS`: Presence-claim heartbeat interval in ms (default: `5000`, TTL/3). Holders refresh their claim on this cadence; awareness-silent sessions probe for a freed claim.
- `AGENT_CLAIM_OP_TIMEOUT_MS`: Per-operation bound on presence-claim Redis commands in ms (default: `500`). On timeout or error the session fails open and announces anyway — claim coordination never delays or fails agent tool calls.
- `AI_CHAT_MODEL`: Optional _fallback_ default for the in-app AI assistant's model on the shared key. The shared default is now editable at runtime from the Admin page (stored in `app_settings`, see below); `AI_CHAT_MODEL` only applies when no admin selection has been made, and the `DEFAULT_MODEL_KEY` code constant in `server/api/chat-models.js` (`claude-opus`) applies when neither is set. Supported values: `claude-haiku`, `claude-sonnet`, `claude-sonnet-5`, `claude-opus`, `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-3-flash`, `gemini-3.1-pro`, `gemini-3.5-flash`. (The OpenAI models `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` have no shared server key and are usable only via BYOK, so they're not valid as a shared server default.)
- `ANTHROPIC_API_KEY`: Anthropic API key (required when using `claude-haiku`, `claude-sonnet`, or `claude-opus` model)
- `GOOGLE_GENERATIVE_AI_API_KEY`: Google AI API key (required when using a `gemini-*` model)
- `ADMIN_EMAIL`: Email address for admin notifications — sign-up, login, AI credit-limit exhaustion, support requests, and unhandled exception alerts (optional; all notifications skipped if unset)
- `SES_FROM_EMAIL`: AWS SES verified sender address for transactional email — admin notifications, document share invitations/notifications, plus the admin-triggered beta welcome email (optional; email is skipped if unset). Set to `no-reply@squiredocs.com`. Sending invitations to external (non-admin) recipients requires the SES account to have production access (out of the sandbox) and the `squiredocs.com` domain verified in SES. Note: user-initiated share email is additionally gated per user by the `users.email_enabled` flag (off by default; toggled from the Admin page) — admin/ops notifications to `ADMIN_EMAIL` are not gated
- `SES_SMTP_HOST`: SES SMTP endpoint (default: `email-smtp.us-west-2.amazonaws.com`)
- `SES_SMTP_USER`: SES SMTP username
- `SES_SMTP_PASS`: SES SMTP password
- `S3_IMAGE_BUCKET` / `S3_IMAGE_REGION`: Dedicated S3 bucket + region for document image storage (optional; image uploads are disabled if unset). Use a separate bucket from DB backups.
- `GUARDRAIL_FRESHNESS_SECONDS`: Collaboration guardrail freshness window in seconds (default: `10`) — a human-attributed update deleting agent content created within this window raises the `collab-guardrail` alert (feature 021)
- `GUARDRAIL_SUPPRESSION_MS`: Guardrail alert suppression window per (doc, user) pair in ms (default: `300000`); suppressed matches are counted and carried on the next alert
- `COLLAB_READ_GAP_RETRIES`: Max full re-fetches when `getYDoc` detects a clock gap in the update log (default: `2`; feature 021)
- `COLLAB_READ_GAP_RETRY_DELAYS_MS`: Comma-separated waits between gap-read retries in ms (default: `100,300`)
- `RL_COLLAB_SKIP_PER_MIN`: Per-user rate limit for the render-skip beacon `POST /api/collab/render-skip-report` (default: `30`)
- `CREATE_DOCUMENT_NUDGE_BYTES` / `CREATE_DOCUMENT_REFUSAL_BYTES`: Teaching thresholds for retyped markdown in the `create_document` MCP tool, in UTF-8 bytes (defaults: `2048` / `10240`). At/above the nudge the success result appends a byte-channel pointer; at/above the refusal the call is soft-refused unless `allowRetyped: true`. Read per call (no restart needed); any invalid pair (non-integer, ≤ 0, refusal ≤ nudge) falls back to BOTH defaults
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`: IAM credentials for the document image bucket (`s3:PutObject`/`GetObject`/`DeleteObject`)

Example using connection string:
```bash
PORT=3001 DATABASE_URL=postgresql://user:password@localhost:5432/collab_db npm start
```

Example using individual config:
```bash
PORT=3001 DB_HOST=localhost DB_PORT=5432 DB_NAME=collab_db DB_USER=postgres DB_PASSWORD=password npm start
```

### MCP OAuth Secrets

The application includes OAuth 2.0 support for AI agents via the Model Context Protocol (MCP). These secrets are used to sign JWT tokens for agent authentication.

**For local development**, generate secrets and add them to your `.env` file:

```bash
./script/generate-mcp-secrets.sh
```

This will output environment variables to add to your `.env` file:
- `MCP_JWT_SECRET`: Signs agent access tokens (JWT)
- `MCP_REFRESH_SECRET`: Signs refresh tokens
- `MCP_AUTH_CODE_SECRET`: Hashes authorization codes

**For Kubernetes deployment**, generate a secret YAML file:

```bash
./script/generate-mcp-secrets.sh --k8s
```

This creates `k8s/mcp-auth-secret.yaml` which is automatically applied during deployment. The generated file is gitignored for security.

**Manual Kubernetes secret creation:**

```bash
kubectl create secret generic mcp-auth-secret \
  --from-literal=MCP_JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  --from-literal=MCP_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  --from-literal=MCP_AUTH_CODE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -n collab
```

See [docs/mcp-auth-production-plan.md](docs/mcp-auth-production-plan.md) for complete MCP OAuth documentation.

### WebSocket URL

The frontend connects to the WebSocket server at the `/s` path. By default, it connects to `ws://localhost:3001/s`. To change this, set the `VITE_WS_URL` environment variable when building:

```bash
VITE_WS_URL=ws://your-server.com/s npm run build
```

### Observability & Telemetry

The server is instrumented with vendor-neutral **OpenTelemetry** (feature 014):

- **Structured logs**: every `console.*` call emits one line of JSON to stdout
  (`{ level, time, msg, ... }`). Lines emitted inside an HTTP request also carry
  `trace_id` / `span_id` for correlation. No existing log call site was rewritten
  — a non-throwing `console` shim (pino) does this globally.
- **Traces**: HTTP → Express → PostgreSQL → Redis are auto-instrumented into one
  correlated trace per request (route templates as the low-cardinality identity,
  never concrete URLs). Manual operation-level spans cover the Yjs collaboration
  path (Redis pub/sub, markdown sync) and MCP tool execution.
- **Metrics**: HTTP request rate / latency / 5xx (by route template + status
  class), a rate-limit rejection (429) counter (by limiter category), and
  PostgreSQL pool gauges (total / idle / waiting).
- **Export**: all telemetry ships via **OTLP http/protobuf** to the endpoint in
  `OTEL_EXPORTER_OTLP_ENDPOINT` when set. With no endpoint configured the whole
  stack is **inert** — no exporter, no crash, no startup delay, no log noise —
  so dev, CI, and the test suite run unchanged with no Collector.
- **Privacy invariant**: document content (text, titles, search queries, chat
  content) never enters any log field the instrumentation adds, span attribute,
  or metric label. Enforced by an allowlist plus a redaction span processor and
  proven by sentinel-content tests.

The Collector, monitoring node (OpenObserve), dashboards, and alarms are the
observability platform (feature 013) — see `design/observability-and-telemetry.md`
and `docs/operations.md`.

### Collaboration Binding Hardening (feature 021)

The collaborative editor binding must never destroy remote content. Stock
`@tiptap/y-tiptap` has two self-repair paths that can delete *shared* content
from a merely-watching viewer's browser and attribute the deletion to that
viewer (confirmed incident, 2026-07-18): the render catch-blocks delete the
shared element/text on a render failure, and an unguarded selection-restore
abort plus an ungated editor→Yjs diff can "correct" the shared doc back to a
stale view. Three defenses (design ground truth:
`design/collaboration-core.md`, 021 amendments + Addition):

- **Binding patch (client)** — `@tiptap/y-tiptap` is exact-pinned to `3.0.7`
  and patched via **patch-package**: `client/patches/@tiptap+y-tiptap+3.0.7.patch`
  is applied by the client `postinstall` (`patch-package --error-on-fail`, so a
  bump without a rebased patch fails the install loudly). Five `SQUIRE-021:`
  sentinel sites: render failures attempt a `createAndFill` stand-in then
  log-and-skip (never mutate the shared doc; bounded once-per-element logging +
  a server-side skip report); selection restore is exception-guarded with a
  clamped near-fallback; the editor→Yjs write-back only runs when the
  transaction actually changed the doc; detected divergence re-renders FROM
  Yjs; and a tracked-skip registry makes skipped nodes invisible to the PM→Y
  diff so a later legitimate edit can't delete them "through the front door".
  A drift-guard test (`client/src/__tests__/binding-patch-guard.test.js`) pins
  the version, the sentinels, and the patch file (SC-007).
- **Runtime kill-switch** — all four patched behaviors revert to verbatim
  stock via one flag, no rebuild: `app_settings.collab_binding_hardening`
  (absent = ON), flipped with `PUT /api/admin/settings/collab-binding-hardening
  {"enabled":false}` and delivered to browsers by `GET /api/client-config` →
  `globalThis.__SQUIRE_COLLAB_HARDENING__` (read live; at most a page refresh
  to take effect; fetch failure fails safe to hardened). The guardrail and the
  quarantine layer are independent of this flag.
- **Quarantine second layer** — TipTap `enableContentCheck`/`onContentError`
  on the editor: a whole-doc schema mismatch (doc uses node types this bundle
  lacks) disables collaboration, makes the editor read-only, and shows a
  refresh banner instead of letting anything "repair" shared content.
- **Skip observability** — skip/stand-in events are batched to the
  authenticated beacon `POST /api/collab/render-skip-report` (content-free:
  node type + error class + count only), which logs a `[CollabSkipReport]`
  line and increments the `collab.render_skip.reports` OTel counter.
- **Server guardrail (detection, never prevention)** — after each
  human-attributed update persists, `server/collab-guardrail.js` intersects
  its Yjs delete set with item ranges inserted by agent-attributed rows
  younger than ~10 s; a match raises an exception-notifier alert (doc, human,
  agent, DB clock range — feature-016 invertible) with per-(doc,user)
  suppression. It never blocks, delays, or modifies updates.
- **Gap-tolerant reads** — `getYDoc` detects clock gaps within the fetched
  rows (a read racing a mid-commit row), retries the full fetch briefly
  (≤2 retries, ~100/300 ms), then serves as-is with a
  `served with clock gap` log line; gap-free reads are unchanged.

Env knobs (all optional): `GUARDRAIL_FRESHNESS_SECONDS` (default `10`),
`GUARDRAIL_SUPPRESSION_MS` (default `300000`), `COLLAB_READ_GAP_RETRIES`
(default `2`), `COLLAB_READ_GAP_RETRY_DELAYS_MS` (default `100,300`),
`RL_COLLAB_SKIP_PER_MIN` (skip-beacon rate limit, default `30`).

## Usage

1. **Sign in**: Authenticate with Google OAuth
2. **Create or open documents**: Access your documents from the list page
3. **Share documents**: Click the Share button to add users with Editor or Viewer access. The email field autocompletes against existing users. You can also share with someone who hasn't signed up yet — they receive an email invitation and gain access automatically the first time they sign in. During public beta, outbound share email is disabled per user by default; an admin marks a user "trusted" (Admin page) to enable it. When disabled, sharing still grants access/records the invite — only the email is suppressed
4. **Edit collaboratively**: Multiple users can edit simultaneously with real-time sync
5. **View version history**: Click the History button to view, name, and restore previous versions
6. **Manage permissions**: Editors and Owners can change roles and remove access

### Document Roles

- **Owner**: Full control (edit, share, manage, delete)
- **Editor**: Can edit and manage sharing
- **Viewer**: Read-only access, can only add other viewers

See [docs/permissions.md](docs/permissions.md) for detailed permission documentation.

## Version History

The editor maintains a complete version history of all document changes, enabling review and restoration of previous states.

### How It Works

**Auto-Versioning**: Consecutive edits within a 5-minute window are automatically grouped into a single version. When editing pauses for more than 5 minutes, a new version begins. This prevents every keystroke from creating a separate version while preserving meaningful checkpoints.

**Named Versions**: Users can explicitly name any version (e.g., "Final Draft", "Before Refactor"). A named version is a pure clock-range label — content is always rebuilt by replaying the update log (the single source of truth; no cached snapshots), so a named version can never diverge from the history it labels.

**Write ordering & timeline cost**: Updates are persisted through a per-document ordered queue with a Postgres advisory-lock backstop, so clock order always matches the order edits were made (a version coordinate can never silently contain a later edit but miss an earlier one). Each update's "meaningful vs. noise" classification is computed once at write time and stored (`yjs_updates.meaningful`), so building the timeline reads rows instead of replaying the whole document per request; `server/scripts/backfill-meaningful-classification.js` backfills historical rows idempotently.

**Author Tracking**: Each edit records the user (or AI agent) who made it. Versions display all contributors with deterministic avatar colors. Agent edits are tagged with the agent name for transparency.

### UI Navigation

The version history panel uses a three-level hierarchy:
1. **Month** - Versions grouped by calendar month
2. **Version** - Auto or named versions (5-minute grouping threshold)
3. **Sub-versions** - Drill into a version to see grouped edits (10-second grouping threshold)

### Restoring Versions

Restore is **non-destructive**: restoring a previous version creates a new version with that content rather than discarding subsequent history. All users see the restored content in real-time (delivered cross-instance, never silently skipped). A restore is recorded like any other tracked edit, so the chat assistant's Undo can invert it, and both surfaces (web UI and MCP `restore_document_version`) share identical attribution and broadcast semantics.

### Diff Highlighting

Version history includes visual diff highlighting to show what changed between versions:

- **Markdown-based diffs**: Both versions are converted to markdown, diffed, then rendered back into the editor with insertion (green) and deletion (red) marks
- **Word-level two-tier highlighting**: When a passage is edited (not purely added or removed), the changed words get a stronger highlight layered over the subtle line tint, GitHub-style — a replace region is re-diffed word-by-word (`shared/diff/word-diff.js`) and the strong `diffInsertWord`/`diffDeleteWord` marks are stamped by post-processing the parser output (`server/diff/apply-word-marks.js`). Oversized or misaligned regions degrade gracefully to the line-level marks. The chat diff cards use the same word segmentation (an additive `inlineSegments` payload field rendered as emphasized spans)
- **Formatting-change detection**: When the text content is identical but formatting has changed (e.g., bold, italic, color, font size), the diff displays a "Formatting changes only" notice and highlights the affected spans
- **Toggle**: Diff highlighting can be toggled off to view the plain document at that version

**Markdown parsing & format pipeline**: The markdown → ProseMirror parser and the format registry live under `shared/` (client- and server-safe, no Node built-ins), so one grammar can serve the server and, in future, editor paste. `markdownToPm(markdown, diffMark, { strict })` has two modes:

- **Tolerant (default)** — a bounded, in-house CommonMark + GFM subset (emphasis variants, loose/lazy/multi-paragraph and nested lists, setext headings, indented + fenced code, autolinks, backslash escapes, HTML entities, hard breaks in both accepted forms — trailing backslash and `<br>` — and GFM task lists parsed into real `taskList`/`taskItem` nodes with checked state). It enforces a **never-lose-content** rule: any input parses to a schema-valid document without throwing, and every word of the input survives — worst case, unknown constructs degrade to literal-text paragraphs. This is what import surfaces and agent-authored markdown use.
- **Strict** — a frozen, byte-identical copy of the pre-existing exact-dialect parser, used by the version-diff engine so partial hunk fragments (e.g. a fragment ending in `---`) keep parsing exactly as before; the Redis diff cache (`CACHE_VERSION`) stays valid.

Inline-format knowledge (delimiters, HTML tags, style props) lives only in `shared/format-registry.js`, so adding a mark extends the serializer, both parser modes, and the round-trip suite with zero parser edits. The full supported-grammar and degradation-ladder tables are in [`specs/001-general-markdown-parser/data-model.md`](specs/001-general-markdown-parser/data-model.md).

### Markdown Import Surfaces

Import is the inverse of export: it turns untrusted markdown into rich document blocks through a single server-side module (`server/markdown-import.js`), so every surface enforces the same invariants. Four surfaces wrap it:

- **MCP `create_document({ markdown })`** — one call creates a fully populated, titled, attributed document. Title precedence: explicit `title` → frontmatter `squire: title` → first heading → `Untitled` (a title-donor heading stays in the body).
- **REST `POST /api/docs/import`** — same one-call create over HTTP with an `sk_sqd_` token (owner = the acting user).
- **REST `PUT /api/docs/:docId/import?mode=append|replace|sync`** — import into an existing document (default `append`; `replace` swaps the body in a single attributed undo step; `sync` pushes edited repo files back as CRDT operations — see [Two-Way Sync](#two-way-sync) below). Requires the editor role.
- **MCP `fromMarkdown(md)` sandbox helper** — convert markdown to detached nodes inside a `modify` script and place them with the positioning primitives you already use (same contract as `cloneBlocks`).

Both REST routes return a **verification receipt**: `markdown` is the canonical re-export of the post-import document (`?flavor=portable|squire`, default portable), so fidelity checking is an exact comparison. Pass `?frontmatter=true` to get the receipt stamped with the `squire:` frontmatter block (docGuid, clock) — written back over the source file it makes the document **born syncable**, a valid `mode=sync` baseline with no separate export step (design proposal §1.2.1, 2026-07-14).

Security posture (constitution Principle V — import is an untrusted ingestion surface): every surface requires an authenticated principal (`documents:write` for scoped tokens; PUT also requires editor role); markdown bodies are capped at 5 MB and rejected before parsing; unsupported content types → 415. Content is parsed only via feature 001's tolerant parser (never executed as HTML beyond the registry whitelist). Link hrefs are protocol-allowlisted (`http`/`https`/`mailto`/app-relative — `javascript:`/`data:`/`vbscript:`/`file:` lose the link mark, text kept).

**Image fetch-and-rehost policy**: external `http(s)` image references are fetched server-side and rehosted into the app's image storage (attributed to the acting user), then rewritten to app URLs — so imported documents stay self-contained and never make viewers' browsers load attacker-chosen URLs. The fetch is SSRF-safe (`server/image-rehost.js`): `http`/`https` only; the resolved address of the initial request and **every redirect hop** is validated against private/loopback/link-local/metadata/CGNAT/unique-local/multicast ranges (v4, v6, and IPv4-mapped/NAT64 forms), with the connection **pinned to the validated IP** (no DNS-rebind window); 3-redirect cap, 10 s timeout, the existing 15 MB byte cap enforced while streaming, and the existing png/jpeg/gif/webp MIME allowlist. Up to 20 unique images are fetched per import (deduplicated). Every failure — SSRF block, size, type, budget, or storage unconfigured — degrades to a plain link and is itemized in the response `images` report rather than failing the import. `data:` image srcs are rejected outright (dropped to alt text). After any import the stored document contains **zero** external and **zero** `data:` image srcs.

**Frontmatter**: a leading `---` YAML block is consumed defensively — recognized `squire:` fields are used (currently `title`), unknown keys are ignored, and any non-`squire:` keys are preserved as a leading fenced `yaml` code block so nothing is lost. Malformed YAML is treated as ordinary content; frontmatter never fails an import and never executes.

### Two-Way Sync

`PUT /api/docs/:docId/import?mode=sync` is the write half of the repo round trip: a document exported to a Git repo (with `frontmatter=true`) can be edited by humans or tooling (e.g. spec-kit) and pushed back. Rather than clobbering the document, its edits **replay as native CRDT operations anchored at the export-time baseline clock** — exactly as if the repo editor were a collaborator who went offline at that clock, edited, and reconnected. This preserves the CRDT identity, marks, undo history, and attribution of every untouched block (constitution Principle IV); only the blocks the file actually changed are touched, character edits stay in-place, and block replacement is the bounded last resort for structural changes.

- **Baseline**: taken from the file's `squire: clock` frontmatter (an explicit `?baselineClock=` param overrides). The reconstructed CRDT state at that clock is forked under a synthetic client identity; the file is character-diffed against the fork's canonical markdown and each hunk is replayed on the fork. The fork's update-since-baseline is applied to the live document through the normal update path.
- **Convergence, not conflict**: concurrent live edits merge deterministically via CRDT semantics — no conflict states, no compare-and-set, no retry, no lock. Blocks changed on **both** sides since the baseline come back as advisory `overlaps` flags for after-the-fact review in version history; they never block or alter the push. Application is order-independent and retried pushes are idempotent (deterministic replay + CRDT dedup), so at-least-once delivery is safe.
- **Receipt**: a content-changing push returns `{ clock, markdown, overlaps, operations }` — `markdown` is a canonical re-export of the post-push document with refreshed frontmatter, which the tool rewrites its local file from so it is immediately a valid next baseline. A byte-identical, formatting-only, or lossy-degradation-only push is a true **no-op** (`noop:true`): zero operations, no stored update, no version entry — so pull→push loops never generate phantom edits. This round-trip invariant (`import(export(doc))` ≡ no-op) is enforced continuously in CI.
- **Attribution**: the version entry is authored by the token identity, agent-style (`Repo Sync (<user>)`). Optional on-behalf-of provenance (git author name/email, commit sha, url) may be supplied via `X-Squire-On-Behalf-Of-{Name,Email,Commit,Url}` headers (each ≤256 chars) and is surfaced in version history strictly as inert plain text.
- **Stale/invalid baselines** are rejected machine-readably (`sync_baseline_missing`/`sync_baseline_invalid` 400, `sync_baseline_unavailable` 410, `sync_doc_mismatch` 409) with re-pull guidance and zero document mutation. The server never degrades to whole-document replacement — `mode=replace` remains the explicit opt-in for clobber writes.

The push is API-first (any client can implement pull/push against it); see `get_tool_documentation({ tool: "export_api" })` for curl recipes.

### Enhanced Features

**Nested Sub-versions**: Optionally drill down into individual edit groups within a version using the `includeSubversions` parameter. Sub-versions use a 10-second grouping threshold for granular change tracking.

**Time-based Filtering**: Filter versions by date/time range using ISO 8601 timestamps:
```javascript
// Get versions from a specific date
await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-15T00:00:00Z"
});

// Get versions in a date range
await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-01T00:00:00Z",
  until: "2024-01-31T23:59:59Z"
});
```

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/docs/:docId/history` | Get version timeline |
| `GET /api/docs/:docId/history/updates?from=X&to=Y` | Get individual updates in clock range |
| `GET /api/docs/:docId/history/clock/:clock` | Get document state at specific clock |
| `GET /api/docs/:docId/versions/:versionId` | Get content at named version |
| `POST /api/docs/:docId/versions` | Create named version |
| `POST /api/docs/:docId/restore` | Restore to previous version |
| `GET /api/docs/:docId/export?format=markdown` | Export document as a Markdown file download. Options: `flavor=squire\|portable` (default `portable`), `frontmatter=true\|false` (default off), `format=bundle` for a zip of markdown + image assets with relative references (bundle defaults to `portable` + frontmatter, overridable) |
| `POST /api/docs/import` | Create a new document from a `text/markdown` body (owner = acting user) |
| `PUT /api/docs/:docId/import?mode=append\|replace` | Import markdown into an existing document (editor role required) |
| `PUT /api/docs/:docId/import?mode=sync` | Push edited repo file back as CRDT ops anchored at its baseline clock (two-way sync); returns clock + canonical re-export + advisory overlaps |

The import routes require `documents:write`, accept `text/markdown`/`text/plain` bodies capped at 5 MB, and return an itemized image report; see [Markdown Import Surfaces](#markdown-import-surfaces) or `get_tool_documentation({ tool: "export_api" })`.

## In-App AI Assistant

A built-in chat panel lets users interact with an AI assistant directly inside the app. The assistant can read, edit, and manage documents using the same MCP tools that external agents use.

### How It Works

- **Model**: The shared (non-BYOK) default is set from the **Admin page** ("Shared assistant" → Default model) and persisted in the `app_settings` table. Its precedence is: admin selection → `AI_CHAT_MODEL` env var → `DEFAULT_MODEL_KEY` code constant (Claude Opus 4.8). Only models whose provider has a shared server key are selectable as the default (OpenAI is BYOK-only and excluded). Supported models:
  - `claude-opus` — Claude Opus 4.8 (requires `ANTHROPIC_API_KEY`; the default)
  - `claude-sonnet` — Claude Sonnet 4.6 (requires `ANTHROPIC_API_KEY`)
  - `claude-sonnet-5` — Claude Sonnet 5 (requires `ANTHROPIC_API_KEY`)
  - `claude-haiku` — Claude Haiku 4.5 (requires `ANTHROPIC_API_KEY`)
  - `gemini-2.5-flash` — Gemini 2.5 Flash (requires `GOOGLE_GENERATIVE_AI_API_KEY`)
  - `gemini-2.5-pro` — Gemini 2.5 Pro (requires `GOOGLE_GENERATIVE_AI_API_KEY`)
  - `gemini-3-flash` — Gemini 3 Flash (Preview) (requires `GOOGLE_GENERATIVE_AI_API_KEY`)
  - `gemini-3.1-pro` — Gemini 3.1 Pro (Preview) (requires `GOOGLE_GENERATIVE_AI_API_KEY`)
  - `gemini-3.5-flash` — Gemini 3.5 Flash (requires `GOOGLE_GENERATIVE_AI_API_KEY`)
  - `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` — OpenAI models, selectable only when the user supplies their own OpenAI key (BYOK)
  - `glm-4.6`, `glm-4.7`, `glm-5`, `glm-5.2` — z.ai (Zhipu) GLM models, selectable only when the user supplies their own z.ai key (BYOK). z.ai speaks the OpenAI chat-completions wire format, reached via `@ai-sdk/openai-compatible` pointed at `https://api.z.ai/api/paas/v4` (that provider targets chat-completions by default — z.ai has no Responses API — and parses GLM's `reasoning_content` into UI thinking blocks)
  - `or-glm-4.6`, `or-glm-4.7`, `or-glm-5`, `or-glm-5.2` — the same GLM models reached through the [OpenRouter](https://openrouter.ai) gateway (namespaced model ids like `z-ai/glm-5.2`), selectable only when the user supplies their own OpenRouter key (BYOK). Also `@ai-sdk/openai-compatible` (base URL `https://openrouter.ai/api/v1`; parses OpenRouter's `reasoning` field). These bill through the user's OpenRouter account, so they're separate model keys from the direct `zai` provider. Unlike direct z.ai, OpenRouter models get web search via OpenRouter's `:online` web plugin (wrapped as a function tool, whose sub-call uses a dedicated `@ai-sdk/openai` client so `url_citation` annotations map to sources)
- **Framework**: AI SDK v6 (`@ai-sdk/react` on the client, `ai` + `@ai-sdk/anthropic`, `@ai-sdk/google`, or `@ai-sdk/openai` on the server; z.ai and OpenRouter use `@ai-sdk/openai-compatible` with a custom base URL). Providers are registered in `server/api/ai-providers.js`. GLM reasoning is streamed to the UI and persisted but stripped from outgoing history (`stripReasoningFromHistory`) so it isn't fed back as `reasoning_content`
- **Endpoint**: `POST /api/chat` — streams responses to the client
- **Tools**: All 16 advertised MCP document tools (including `import_markdown_file`; `read_document_version` left the advertised list — versioned reads go through `read_document`'s `versionId` parameter) plus the chat-only tools (`import_markdown`, `insert_image`, `view_image`, `view_svg_blocks`) and web search and web fetch. The script tools (`modify`, `compare_document_versions`) expose their full API reference to the chat agent via `chatDescription` (external MCP clients get a short description instead — see `get_tool_documentation` below). Web search works for Anthropic, Google, OpenAI, and OpenRouter — Gemini wraps Google Search and OpenRouter wraps its `:online` web plugin as function tools; Anthropic and OpenAI use their provider-executed web search. Direct z.ai gets web fetch but no web search. Web fetch is universal across all providers
- **Context-aware**: When a document is open, the assistant knows its title and can operate on it directly
- **Add selection to chat**: Selecting text in the editor surfaces an "Add to Chat" affordance; clicking it captures the passage (plus the source document and the heading it sits under) as a reference chip in the chat input and opens the panel. On desktop the tag floats just below the selection; on touch devices it docks as a pill above the on-screen keyboard (anchored to the visual viewport) so it never collides with the native iOS/Android selection callout (Cut/Copy/Paste), which hugs the selection. On send, the quoted passages are prepended to the message inside a `<referenced_passages>` block — each entry naming its source document and id (rendered as chips in the transcript, not raw markup) so the assistant knows exactly what the user is pointing at and which document it came from, even when a single chat references passages from several documents. No position anchoring — the quote is enough for the assistant to answer or to locate the passage via `read_document` if it needs surrounding context. Client-only (`SelectionChatButton.jsx`, pending refs on `AiChatContext`); the server prompt has a nudge in `buildSystemPrompt`
- **Chat history**: Conversations are persisted to the database with a history sidebar for searching, renaming, and switching between past chats; the active chat is preserved across page refreshes via sessionStorage
- **Thinking display**: While a model reasons, the chat shows a single-line **live summary of its thinking**: the block instantly reads "Thinking", then every 3 seconds the client polls `POST /api/chat/thinking-summary` with the accumulated reasoning text and a cheap model (`getThinkingSummaryModel()`, Claude Haiku 4.5 on the shared key — unmetered, works regardless of which model/BYOK key powers the chat) condenses it to a short phrase that replaces the label (polling starts once ~20 chars of reasoning have streamed; a burst that finishes below that is summarized once on completion, so every block the user watched think ends with a real label). The full train of thought is deliberately **not** rendered (no expansion); summaries are ephemeral client state, so historical blocks just read "Thinking" after a reload. Works across all reasoning-capable providers: Anthropic (adaptive thinking with `display: 'summarized'` — required on Sonnet 5/Opus 4.7+ where visible thinking otherwise defaults to omitted; needs `@ai-sdk/anthropic` ≥ 3.0.94 — and `budgetTokens` on Haiku), Gemini (`thinkingConfig.includeThoughts`), OpenAI (`reasoningSummary: 'auto'`, BYOK), and GLM via z.ai / OpenRouter (`reasoning_content` parsed by `@ai-sdk/openai-compatible`)
- **Stop generation**: Abort a streaming response at any time with the stop button
- **Inline diffs**: When the `modify` tool edits a document, a color-coded markdown diff (green additions, red deletions) appears directly in the chat message with expandable sections for large changes. Successful `undo`/`redo` tool calls carry the same diff payload — computed server-side from the states immediately bracketing the applied inverse, so after partial supersession it shows only what actually reverted, never a mirror of the original edit — and their tool cards render it with the same DiffView; the diff persists on the tool part, so it re-renders after reload. Honest-empty results (`undone`/`redone: false`) carry no diff and stay label-only
- **Undo agent edits**: The most recent `modify` diff has an Undo button that reverts the edit via the `/api/docs/:id/undo` and `/redo` endpoints. Undo is **log-derived and stateless**: every content-changing `modify` records the clock range of exactly its own rows in the `yjs_updates` log (returned as `editRange` in the result and stored in the `agent_edits` table), and the server derives the edit's exact surgical inverse from those logged updates — what the edit inserted comes out, what it deleted comes back, and everything anyone wrote afterwards is preserved (unlike a version restore). The inverse is applied as a normal attributed forward update (history is never rewritten; it shows up in version history like any edit). Because the log is durable and shared, undo works from any server instance, survives session expiry and server restarts, and creates no agent presence session; redo inverts the inverse's own recorded range, so the undo↔redo chain works indefinitely. When later edits have already superseded everything the edit did, the endpoints answer an honest "nothing left to undo" (`undone: false` + message) instead of pretending. After undoing, the diff is dimmed and marked "Reverted" (kept as a record of what the agent did, not rewritten) and the button flips to Redo; the reverted state is persisted on the chat message (a `reverted` flag on the tool part) so it survives reloads. The button appears on the latest edit while `/api/docs/:id/undo-status` (also log-derived — no session lifetime) reports it undoable. Edits made before this mechanism shipped degrade honestly: where the log identifies them unambiguously they undo, otherwise the surfaces report unavailability — never a guessed inverse. The `/undo`/`/redo` responses additionally carry the revert's `diff` (same shared handler as the MCP tools), but the button UI doesn't render it — the original modify diff plus the dimmed "Reverted" state already tell the story there
- **Image upload**: Attach up to 5 images per message (PNG, JPEG, GIF, WebP; max 15 MB each) via drag-and-drop or file picker, with thumbnail previews before sending. Uploaded bytes go to S3 and the message carries a short `attachment:<key>` reference instead of inline base64 (keeps request bodies and stored messages small); the transcript resolves that reference to a short-lived presigned URL via `GET /api/chat/attachments/resolve` before rendering the `<img>` (a bare `<img src>` can't carry the auth token — same pattern as document images in `ImageNodeView.jsx`). Image attachment is gated on the selected model's vision support: the GLM text models (z.ai + OpenRouter) can't accept images, so the paperclip drops images with a "switch to a vision-capable model" notice when one of them is the active BYOK model (`supportsImages` on the model registry drives both the client gate and a server-side pre-flight in `chat.js` that rejects an image on a text-only model with the honest `model_no_image_support` error, instead of the provider 404-ing the whole turn)
- **Markdown file import from chat**: Drop a `.md`/`.markdown` file into the chat (or pick it with the paperclip; max 5 MB) and it attaches like any file — shown as a file card on the user's message — but its content never reaches the model: `chat.js` swaps the file part for a short text note in the model input (`replaceMarkdownFileParts`) and the assistant imports the bytes from the attachment store into a new document with the chat-only `import_markdown` tool (title defaults to the file name), then links the result. Detection by extension with mediaType normalized to `text/markdown` (`AiChatInput.jsx`); upload rides the standard `/api/chat/attachments` reference path, which accepts `text/markdown` alongside the image types
- **Working with images**: The assistant can put an image you attached into a document (`insert_image` — uploads it to S3 and inserts the node), *see* images already in a document to describe or answer questions about them (`view_image` — fetches the bytes as vision input), and move/reorder/delete or re-caption existing images via the `modify` tool. To prevent injecting external/tracking URLs, agent-written image `src` values must be app image URLs (`/api/docs/:docId/images/:imageId`); any other src is stripped
- **Seeing SVG blocks**: The assistant can also *see* a rendered SVG block (`view_svg_blocks` — sanitizes the block's source through the same policy the editor renders with, rasterizes it to PNG server-side via `@resvg/resvg-js`, and feeds it to the model as vision input). This closes the loop on agent-drawn SVGs: after writing an SVG block with `modify`, the assistant can look at the actual rendered result and fix visual problems, not just syntax errors
- **Copy button**: Each chat message has a copy-to-clipboard button on hover
- **Adjustable chat text size**: An A−/A+ stepper in the chat header scales only the chat message text (independent of the rest of the app's typography). The preference is saved per-device in localStorage and applies to both the docked panel and the full-page chat
- **SPA navigation**: Internal document links in chat messages use client-side navigation instead of full-page reloads
- **BYOK (Bring Your Own Key)**: Users can supply their own Anthropic, Google, OpenAI, z.ai, or OpenRouter API keys on the Settings page. When BYOK is enabled, chat requests use the user's key and bypass shared credit limits
- **Reactive compaction**: When a conversation exceeds the model's token limit, the system automatically compacts earlier messages and retries, with a UI indicator
- **Fresh document context**: After a `modify`, the result echoes the updated document so the assistant's view stays current without re-reading. Repeated full-document snapshots (from reads and modifies) are deduplicated in context so only the latest is kept
- **Concurrent-edit awareness**: The assistant tracks the document version (clock) it has seen. If someone else (or you, editing directly) changes a document since it last read it, the assistant is told who changed it, and a `modify` that would overwrite those edits is refused and returns the current content so it can reconcile. This also covers the **Undo button**: an undo is written through the assistant's own identity out-of-band, so the by-author staleness check can't see it. Instead, the persisted `reverted` flag is read back from the chat history — while a doc's most recent assistant edit is one the user has undone (and it hasn't been re-read since), the assistant is told its earlier edit is no longer in the document and silently re-reads before trusting its cached snapshot

### Usage Limits

Each user has a monthly AI credit allowance (default: $10.00). Usage is tracked per-request based on token counts from the AI provider, with costs computed from official pricing. When a user exceeds their allowance, chat requests return a 429 and the UI shows a clear error banner. Usage resets automatically at the start of each calendar month.

- **Credits**: Stored as `ai_credit_cents` on the `users` table (overridable per user)
- **Extra credits**: One-off credit grants via the `ai_extra_credits` table — admins can grant bonus credits that supplement the monthly allowance and persist until depleted or expired
- **Tracking**: Append-only `ai_usage_log` table records every request with model, token counts, and cost
- **Pricing**: Computed from official per-token rates for each model (see `server/ai-usage.js`)
- **No cron needed**: Current month's spend is computed on-the-fly by summing log entries

### Display Modes

- **Right-docked** (default): Sidebar panel with adjustable width (280–600px)
- **Bottom-docked**: Horizontal panel with adjustable height
- **Chat-centric mode** (`/chat`): Full-page chat with conversation history sidebar and optional document side pane
- **Mobile**: Full-screen overlay with keyboard-aware layout

Panel position and size preferences are persisted to localStorage, as is the chat text-size scale (`--chat-font-scale`, adjustable via the header A−/A+ stepper).

### View Toggle

A swap-arrows button in the header switches between document-centric and chat-centric layouts. Context is preserved across toggles:

- **Editor → Chat**: The current document opens in the chat's side pane (passed as a prop, not a URL param)
- **Chat → Editor**: The AI panel auto-opens so the conversation stays visible; if a document was open in the chat side pane, the editor navigates to it
- **Other pages → Chat**: No document context — chat opens clean
- The active document is tracked declaratively via a ref that reflects the current view, not a historical "last visited" value

### Architecture

```
Client                              Server
──────                              ──────
AiChatContext.jsx                   server/api/chat.js
  └─ useAiChat() (AI SDK)            ├─ streamText() with configurable model
       │                              ├─ Model registry (chat-models.js)
       ▼                              ├─ MCP tools via chat-tools.js
                                      └─ Agent presence (cursor/highlights)
AiPanel.jsx ── AiChatMessages.jsx     (document-centric)
            └─ AiChatInput.jsx
ChatPage.jsx ── AiChatHistory.jsx     (chat-centric)
             ├─ AiChatBody.jsx
             ├─ AiChatInput.jsx
             └─ DocSidePane.jsx (optional)
```

The chat endpoint builds a synthetic agent token from the user's session, so tool calls execute with the user's permissions and show up as agent activity in the editor (cursors, highlights). Agent presence is deduplicated cluster-wide via a Redis presence claim (`server/mcp/presence-claim.js`): only the instance executing the current tool call announces the agent in awareness — the claim follows the work across instances, and without Redis (single-instance deployments) behavior is unchanged.

## Onboarding / Welcome Flow

New users are dropped straight into a working, AI-assisted document instead of an empty document list, to avoid the "blank page" problem and reach value quickly.

### Behavior

- **Per-user welcome doc**: On a user's first login, a personal "Welcome to Squire Docs" document is seeded (owned by that user) from a content template. Each user gets their own editable copy — nothing is shared.
- **Lands on the welcome doc until "engaged"**: On every login, a user who is not yet *engaged* is redirected to their welcome doc (`/d/<id>?welcome=1`) with the AI panel open. **Engaged** = the user owns a document *other than* their welcome doc that has content (≥1 persisted Yjs update). Once engaged, the user's `onboarded_at` is stamped and logins go to the normal document list (`/docs`).
- **When `onboarded_at` is stamped**: eagerly, the moment the user creates a real (non-welcome) document — via `POST /api/docs` or the `create_document` MCP tool / in-app assistant — so the flag reflects engagement immediately rather than lagging. As a fallback, `resolveOnboarding()` also re-checks engagement and stamps lazily on the next login or `/auth/me` probe (covering docs that gained content through other paths). The welcome-doc seeding path deliberately never stamps.
- **Assistant speaks first**: On the welcome doc, the assistant streams a live greeting (a real model call) introducing itself and asking what topic to research. This is triggered by a hidden "kickoff" user turn (tagged `metadata.kind: 'welcome-kickoff'`) that is sent through the normal `/api/chat` pipeline but filtered out of the transcript. The `?welcome=1` flag is stripped after firing so refreshes don't re-greet.

### Implementation

- **Schema** (`migrations/1783000000000_add-onboarding-to-users.js`): `users.welcome_doc_id` (FK → `documents`, `ON DELETE SET NULL`) and `users.onboarded_at` (timestamptz; NULL until engaged).
- **Server** (`server/onboarding.js`): `seedWelcomeDoc()` (idempotent; uses `documents.createDocument` + `documentService.updateDocument` with `buildYjsNode` to write content server-side — no live websocket needed), `isEngaged()`, `resolveOnboarding()`, and `markEngagedFromDocCreation()` (idempotent, best-effort stamp called from the real-doc creation paths). The welcome content lives in `server/onboarding/welcome-template.js`.
- **Login wiring** (`server/auth/routes.js`): the OAuth callback and dev-login resolve onboarding (`seed: true`) and choose the redirect; `GET /auth/me` resolves it read-only (`seed: false`) and returns `welcomeDocId` / `onboarded` so the client can route on refresh and dev-bypass.
- **Doc-creation wiring**: `POST /api/docs` (`server/index.js`) and the `create_document` MCP tool (`server/mcp/tools/create-document.js`) call `onboarding.markEngagedFromDocCreation(userId)` after creating the doc — fire-and-forget, so it never blocks or fails creation.
- **Client**: `App.jsx` reads `?welcome=1` (and the `/auth/me` fields on the landing route), opens the panel, and calls `aiChat.sendWelcomeMessage()` once. The kickoff/greeting lives in `client/src/contexts/AiChatContext.jsx`; the hidden message is filtered in `client/src/components/AiChatMessages.jsx`.

### Beta welcome email (admin-triggered)

Separate from the in-app welcome *doc* above: a plain-text-style HTML **welcome email** sent to new sign-ups. It is **never sent automatically** — an admin sends it per user from a button on each row of the Admin page.

- **Send action** (`client/src/pages/AdminPage.jsx`): each user row has a "✉ Welcome email" button; once sent it shows "✓ Welcome email" and displays the send date on hover. Re-sending prompts for confirmation. A confirm dialog notes that the admin is BCC'd.
- **Endpoint** (`server/api/admin.js`): `POST /api/admin/users/:userId/welcome-email` (behind `requireAdmin`) looks up the user, derives their first name from `users.name`, sends the email, and stamps `users.welcome_email_sent_at` on success. Returns 503 if SES is unconfigured, 502 on send failure (no stamp written in either case).
- **Message** (`server/email.js` → `sendWelcomeEmail`): subject "Welcome to Squire Docs", body from the Squire-authored source doc, addressed "Hi &lt;first name&gt;," (falls back to "there"; first name is HTML-escaped). **BCCs `ADMIN_EMAIL`** and sets **Reply-To to `ADMIN_EMAIL`** so replies reach a real inbox rather than the no-reply From. Like share email, delivery to external recipients requires SES production access.
- **Schema** (`migrations/1794000000000_add-welcome-email-sent-to-users.js`): `users.welcome_email_sent_at` (timestamptz, NULL until first sent).

## AI Agent Integration (Model Context Protocol)

This editor also supports external AI agents via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), enabling programmatic document manipulation through AI assistants like Claude Code, Kiro (AWS's spec-driven agentic IDE), and Claude Desktop.

### Features

- **Sandboxed TypeScript execution** - Scripts run in an `isolated-vm` V8 isolate (128 MB memory limit) with zero Node.js API access, on a dedicated worker thread
- **Type-safe editing** - Full TypeScript support with type definitions
- **OAuth 2.0 authentication** with PKCE flow for secure agent access
- **API token authentication** - Personal access tokens (prefixed `sk_sqd_`; legacy `sqd_` tokens remain valid) as a simpler alternative to OAuth for programmatic access. Tokens work on the REST `/api` routes too, with scope enforcement: reads require `documents:read`, mutations require `documents:write`. MCP-connected agents can also self-mint temporary tokens (scoped at or below their own grant, auto-expiring, cascade-revoked with their minting credential) via the `create_access_token` tool — delivered as a one-shot claim (`GET /api/tokens/claim`, Bearer claim secret, 5-min TTL, Redis-backed) that writes the token bytes straight to disk so the credential never transits model context (`inline: true` is the explicit opt-in for shell-less agents)
- **Real-time collaboration** between humans and AI agents
- **Permission enforcement** - agents respect document roles (Owner, Editor, Viewer)
- **Atomic operations** - Entire scripts execute as single undo step
- **Operation tracking** - Visual cursor animations show edit operations
- **Automatic rollback** - Scripts fail safely without corrupting document

### Available Tools

**Document Management:**
- `create_document` - Create new documents with a title (use `modify` to add content). Retyping bulk markdown through its `markdown` parameter is deflected (feature 019): at/above 2,048 UTF-8 bytes the success result appends a byte-channel nudge, and at/above 10,240 bytes the call is soft-refused with an instructive error unless `allowRetyped: true` is passed (always honored — the escape hatch for shell-less agents). Thresholds are tunable via `CREATE_DOCUMENT_NUDGE_BYTES` / `CREATE_DOCUMENT_REFUSAL_BYTES`
- `import_markdown_file` - Sync/import an existing markdown file over the REST byte channel: accepts NO content, no path — returns one ready-to-run compound shell command (one-shot token claim + curl import + receipt write-back) that leaves the file a valid `mode=sync` baseline. Intents: `create` (default), `update` (`mode=replace`), `sync` (default when `docGuid` is given). Requires `documents:write`; mints via the same claim machinery as `create_access_token`
- `list_documents` - List accessible documents (or content-search them); rows include `clock` and `lastModifiedAt`, and `updatedSince` filters to recently edited docs for incremental syncs. Content searches accept `updatedAfter` (search path only, strictly after `updatedAt`, filtered before ranking) — distinct from the list-path-only `updatedSince`
- `share_document` - Share with users and set permissions
- `set_document_title` - Update document titles

**Reading:**
- `read_document` - Read document with optional XPath filtering (structured JSON or Markdown output). Pass `versionId` (version UUID or clock number string) to read a historical version with identical xpath/format semantics — historical reads create no presence session and return version metadata. The old `read_document_version` tool remains executable as a hidden deprecation alias but is no longer advertised (feature 019 DR-1)
- `get_collaborators` - See who else is editing

**Tool Documentation:**
- `get_tool_documentation` - Full API reference for the script tools (`modify`, `compare_document_versions`) and the REST byte channel (`rest_api`), whole or by section. Requires no scope (feature 019 DR-1): it serves static text, so a write-only token can read the docs it needs. MCP clients such as Claude Code truncate tool descriptions at 2KB, so the script tools ship short (≤2KB) descriptions that point here, and script errors append a hint directing agents here. The reference text lives in `server/mcp/tools/tool-documentation/`; the in-app chat agent gets it inline via each tool's `chatDescription`. The MCP `initialize` response's `instructions` field also tells agents to fetch these docs before writing scripts

**Sandboxed Script Execution:**
- `modify` - Execute TypeScript scripts with direct Yjs API access
  - Edit text, format content, create/modify blocks
  - Build complex nested structures
  - Find and replace patterns
  - All changes atomic (single undo)
  - Real-time sync to all users
  - **Multi-document sources** (`sourceDocGuids`): up to 10 other documents can be exposed read-only inside the script as a `sources` global (viewer access suffices; loaded as DB snapshots, no presence session). A `cloneBlocks()` helper deep-copies their content into the target with full formatting fidelity (marks, tables, nested lists) — Yjs nodes can't move between docs, so cloning re-creates them. This lets the agent concatenate/merge documents entirely inside the sandbox instead of re-typing content through chat. Mutation attempts on a source throw; sources never stream updates back, so rollback/undo/conflict semantics stay target-only
  - **Cross-document image copy**: after any modify, image nodes whose src points at a *different* document (e.g. cloned from a source doc) are reconciled — the image (S3 object + `document_images` row) is copied into the edited document and the src rewritten (`imagesCopied` in the result), since the image route authorizes strictly against the URL's docId. Images referencing documents the acting user can't read are stripped and reported in `imageErrors`
  - Returns change detection (`changed`, `operationCount`, `summary`) plus the updated document `content` so the agent's view stays current without re-reading (omitted for very large documents)
  - **Diagram validation**: Mermaid and SVG blocks only render in the browser, so a Mermaid syntax error — or SVG content the editor's sanitizer strips — would otherwise be invisible to the agent. After an edit, the server validates the document's diagram blocks in a jsdom worker (`server/mcp/diagram-validate.js` / `diagram-worker.js`): Mermaid via the same `mermaid.parse()` the editor uses, SVG via the same sanitize policy the editor renders with (`shared/svg-sanitizer.mjs`) plus an XML well-formedness check. Problems come back as `mermaidErrors` / `svgErrors` arrays (`{ block, error, source }`) plus a corrective `message`. This is non-blocking — the edit still applies — so the agent can fix the block in a follow-up instead of leaving the user with a broken render

**History:**
- `list_document_versions` - List version history with optional nested subversions and time-based filtering
- `set_document_version_name` - Create, rename, or delete named versions
- `restore_document_version` - Restore to previous version
- `compare_document_versions` - Compare two versions using custom TypeScript scripts
- `undo` - Undo this agent's most recent edit (log-derived: works across sessions/restarts; repeated calls step back through the agent's own edits; successful results carry a `diff` of what the revert changed, in `modify`'s shape)
- `redo` - Reapply the agent's most-recently-undone edit (inverts the undo's recorded inverse; successful results carry a `diff` like undo's)

### Quick Start

1. **Generate MCP OAuth secrets** (required for agent authentication):
   ```bash
   ./script/generate-mcp-secrets.sh
   ```
   Add the output to your `.env` file.

2. **Configure your AI agent** to connect to the MCP server:
   ```json
   {
     "mcpServers": {
       "collaborative-editor": {
         "command": "node",
         "args": ["path/to/collab/server/mcp/index.js"],
         "env": {
           "DATABASE_URL": "postgresql://user:pass@localhost:5432/collab_db"
         }
       }
     }
   }
   ```

3. **Authenticate and start editing** - The agent will guide you through OAuth authentication, then you can use natural language to edit documents.

**Alternative: API Token Authentication**

For programmatic or headless access, users can create personal API tokens from the Settings page instead of going through the OAuth flow. Tokens are prefixed with `sk_sqd_` (tokens created before the prefix change use `sqd_` and remain valid) and stored as SHA-256 hashes. Pass the token as a Bearer token in the `Authorization` header. An MCP-connected agent that has no token can mint a temporary one itself with the `create_access_token` tool — capped at the agent's own scopes (default `documents:read`), expiring after at most 24 hours, and revoked automatically when the minting credential is revoked.

API tokens also authenticate against the REST `/api` routes, so scripts can move document content over plain HTTP without an MCP client. For example, exporting a document as Markdown is one curl:

```bash
curl -H "Authorization: Bearer sk_sqd_..." \
  "https://squiredocs.com/api/docs/<docId>/export?format=markdown" -o doc.md
```

Token scopes are enforced on REST routes: `GET` requests require `documents:read`, mutating requests require `documents:write` (new tokens get both by default). A request with an insufficient scope fails with `403 {"code": "INSUFFICIENT_SCOPE"}`. Browser sessions and OAuth flows are unaffected. Agents connected over MCP can fetch this recipe with `get_tool_documentation({ tool: "export_api" })`.

### Documentation

- [MCP Quickstart Guide](docs/mcp-quickstart.md) - Complete setup instructions
- [MCP Integration Summary](docs/mcp-integration-summary.md) - Full feature documentation
- [MCP File Structure](docs/mcp-file-structure.md) - Understanding the MCP codebase
- [MCP Auth Production Plan](docs/mcp-auth-production-plan.md) - OAuth implementation details

### Example Usage

```typescript
// AI agents use TypeScript scripts for editing:

// 1. Create a new document with a title
const { docGuid } = await create_document({ title: "My Document" });

// 2. Execute script to add content (session is created automatically)
await modify({
  docGuid,
  script: `
    export default function edit(doc) {
      // Find and format all TODO items as bold
      const blocks = doc.toArray();
      blocks.forEach(block => {
        if (block instanceof Y.XmlElement) {
          const text = findTextNode(block);
          if (text) {
            const content = extractText(text);
            const index = content.indexOf('TODO');
            if (index >= 0) {
              text.format(index, 4, { bold: true });
            }
          }
        }
      });

      // Add a summary section at the end
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 2);
      const headingText = new Y.XmlText();
      headingText.insert(0, 'Action Items');
      heading.insert(0, [headingText]);

      doc.insert(doc.length, [heading]);
    }

    function findTextNode(element) {
      for (const child of element.toArray()) {
        if (child instanceof Y.XmlText) return child;
        if (child instanceof Y.XmlElement) {
          const found = findTextNode(child);
          if (found) return found;
        }
      }
      return null;
    }

    function extractText(xmlText) {
      const delta = xmlText.toDelta();
      return delta.map(op =>
        typeof op.insert === 'string' ? op.insert : ''
      ).join('');
    }
  `
});

// Natural language examples with modify:
"Find all TODO items and make them bold"
"Add a summary section at the end with bullet points"
"Create a table of contents based on headings"
"Find all links and convert them to a reference list"
"Reorganize the document with all headings first"

// IMPORTANT: Creating mixed formatting
// When inserting text with different formatting, ALWAYS pass {} for unformatted text:

await modify({
  docGuid: "abc-123",
  script: `
    export default function edit(doc) {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();

      // ✅ CORRECT - pass {} to prevent inheriting formatting
      text.insert(0, 'BOLD', { bold: true });
      text.insert(4, ' normal', {});  // Empty object prevents inheriting bold!

      // ❌ WRONG - omitting attributes inherits formatting from previous position
      // text.insert(0, 'BOLD', { bold: true });
      // text.insert(4, ' normal');  // This would be bold too!

      para.insert(0, [text]);
      doc.insert(doc.length, [para]);
    }
  `
});

## Hierarchical Document Editing

This editor supports advanced hierarchical document structures with nested lists, subsections, and complex content organization using the `modify` tool with direct Yjs API access.

### Creating Nested Content

**Build complex hierarchical structures with TypeScript:**
```typescript
await modify({
  docGuid: "abc-123",
  script: `
    export default function edit(doc) {
      // Create a nested bullet list
      const list = new Y.XmlElement('bulletList');

      // Main item
      const item1 = new Y.XmlElement('listItem');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'Main item');
      p1.insert(0, [t1]);
      item1.insert(0, [p1]);

      // Nested sub-list
      const subList = new Y.XmlElement('bulletList');
      const subItem = new Y.XmlElement('listItem');
      const subP = new Y.XmlElement('paragraph');
      const subT = new Y.XmlText();
      subT.insert(0, 'Sub item');
      subP.insert(0, [subT]);
      subItem.insert(0, [subP]);
      subList.insert(0, [subItem]);

      // Add sub-list to main item
      item1.insert(1, [subList]);
      list.insert(0, [item1]);

      doc.insert(0, [list]);
    }
  `
});
```

### Example: Creating a Complex Document Structure

```typescript
await modify({
  docGuid: "abc-123",
  script: `
    export default function edit(doc) {
      // Helper to create heading
      function createHeading(level, text) {
        const h = new Y.XmlElement('heading');
        h.setAttribute('level', level);
        const t = new Y.XmlText();
        t.insert(0, text);
        h.insert(0, [t]);
        return h;
      }

      // Helper to create bullet list item
      function createListItem(text) {
        const item = new Y.XmlElement('listItem');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, text);
        p.insert(0, [t]);
        item.insert(0, [p]);
        return item;
      }

      // 1. Create main heading
      doc.insert(0, [createHeading(1, 'Project Plan')]);

      // 2. Add sections with nested content
      doc.insert(1, [createHeading(2, 'Objectives')]);

      const list = new Y.XmlElement('bulletList');
      const obj1 = createListItem('Increase user engagement');
      const obj2 = createListItem('Improve performance metrics');

      // Add nested items under first objective
      const nestedList = new Y.XmlElement('bulletList');
      nestedList.insert(0, [
        createListItem('Implement new UI components'),
        createListItem('Add interactive features')
      ]);
      obj1.insert(1, [nestedList]);

      list.insert(0, [obj1, obj2]);
      doc.insert(2, [list]);
    }
  `
});
```

This approach enables AI agents to create professional documents with proper hierarchical structure, including nested lists, subsections, and complex content organization - all in a single atomic operation.

## Programmatically Updating Documents

You can programmatically update documents using Node.js scripts. This is useful for automation, migrations, or bulk edits.

### Important: Field Name

The TipTap editor uses the `'default'` field with `Y.XmlFragment` for ProseMirror content. **Do not** use `Y.Text` or other field names - they won't appear in the editor.

### Example Script

A sample script is provided at `script/edit-default-doc.js`. Here's how it works:

```javascript
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');

const WS_URL = process.env.WS_URL || 'ws://localhost:3001/s';
const DOC_NAME = process.env.DOC_NAME || 'default-doc';

const doc = new Y.Doc();
// TipTap uses 'default' field with XmlFragment for ProseMirror content
const xmlFragment = doc.get('default', Y.XmlFragment);

const provider = new WebsocketProvider(WS_URL, DOC_NAME, doc, {
  connect: true
});

provider.on('sync', (isSynced) => {
  if (isSynced) {
    // Create a paragraph node with text
    const paragraph = new Y.XmlElement('paragraph');
    const textNode = new Y.XmlText();
    textNode.insert(0, 'Your text here');
    paragraph.insert(0, [textNode]);
    
    // Insert at the end of the document
    xmlFragment.insert(xmlFragment.length, [paragraph]);
    
    // Clean up
    setTimeout(() => {
      provider.destroy();
      process.exit(0);
    }, 1000);
  }
});
```

### Running the Script

```bash
# Edit the default document
node script/edit-default-doc.js

# Edit a specific document
DOC_NAME=my-document node script/edit-default-doc.js

# Connect to a different server
WS_URL=ws://example.com:3001 node script/edit-default-doc.js
```

### Key Points

- **Wait for sync**: Always wait for the `sync` event before making edits
- **Use XmlFragment**: TipTap requires `Y.XmlFragment` in the `'default'` field
- **Create proper nodes**: Insert `Y.XmlElement('paragraph')` nodes containing `Y.XmlText` nodes
- **Clean up**: Call `provider.destroy()` when done to close the connection

### Advanced: Editing Existing Content

To modify existing content, you can traverse the XmlFragment:

```javascript
// Get all paragraphs
const paragraphs = Array.from(xmlFragment.toArray());
paragraphs.forEach((node, index) => {
  if (node.nodeName === 'paragraph') {
    // Modify paragraph content
    const textNode = node.firstChild;
    if (textNode && textNode.nodeType === 3) { // Text node
      textNode.insert(textNode.length, ' appended text');
    }
  }
});
```

## Project Structure

```
.
├── server/
│   ├── index.js              # Express server with WebSocket
│   ├── postgres-persistence.js  # PostgreSQL persistence adapter
│   ├── permissions.js        # Centralized permission checks
│   ├── documents.js          # Document and share management
│   ├── search.js             # Hybrid full-text + semantic document search (RRF)
│   ├── search-indexer.js     # Maintains the FTS + embedding search index
│   ├── redis.js              # Redis caching layer
│   ├── auth/                 # Human authentication (Google OAuth, JWT)
│   ├── api/
│   │   ├── chat.js           # In-app AI chat endpoint (AI SDK + configurable model)
│   │   ├── ai-providers.js   # Provider registry (Anthropic, Google, OpenAI, z.ai, OpenRouter): key validation, SDK factories, web search, capabilities
│   │   ├── chat-models.js    # Model registry (Claude, Gemini, GPT, GLM; direct + via OpenRouter) with lazy provider loading
│   │   ├── chat-tools.js     # Wraps MCP tools as AI SDK tool definitions
│   │   ├── byok-settings.js  # Bring-your-own-key (BYOK) API key management
│   │   ├── web-fetch.js      # Web fetch tool used by the AI assistant
│   │   ├── app-settings.js   # Global admin-editable settings (shared assistant default model)
│   │   └── admin.js          # Admin dashboard endpoints
│   ├── ai-usage.js          # AI usage metering (quota checks, cost computation, usage logging)
│   ├── email.js             # Email: admin notifications (signup, login, credit limit, support), share invites, welcome email
│   ├── exception-notifier.js # Rate-limited exception email alerts
│   ├── chat-store.js        # Chat persistence (CRUD with ownership checks)
│   └── mcp/                  # Model Context Protocol integration
│       ├── index.js          # MCP server entry point
│       ├── tools/            # MCP tools for document operations
│       ├── sandbox/          # isolated-vm script executor (worker thread + V8 isolate)
│       ├── yjs/              # Yjs utilities and serialization
│       ├── auth/             # MCP OAuth 2.0, PKCE flow, and API tokens
│       └── agent-presence.js # Agent session management
├── client/
│   ├── src/
│   │   ├── components/       # React components
│   │   │   ├── Editor.jsx    # TipTap editor component
│   │   │   ├── EditorView.jsx # Editor page with header/toolbar
│   │   │   ├── DocList.jsx   # Document list page
│   │   │   ├── ShareDialog.jsx # Share/permissions dialog
│   │   │   ├── AiPanel.jsx   # AI assistant panel (dock/pop-out/mobile)
│   │   │   ├── AiChatMessages.jsx # Chat message list with markdown + tool cards
│   │   │   └── AiChatInput.jsx    # Chat input textarea
│   │   ├── hooks/            # Custom React hooks
│   │   │   ├── useYjs.js     # Yjs document and WebSocket management
│   │   │   └── useAiPanel.js # AI panel state (position, size, preferences)
│   │   ├── contexts/         # React contexts
│   │   │   ├── AuthContext.jsx    # Authentication state
│   │   │   ├── AiChatContext.jsx  # AI chat provider (AI SDK transport)
│   │   │   └── ByokContext.jsx    # BYOK settings state
│   │   ├── pages/
│   │   │   └── SettingsPage.jsx   # Settings: agents, API tokens, BYOK keys
│   │   └── main.jsx          # Entry point
│   └── package.json
├── shared/                   # Client/server-safe modules (no Node built-ins)
│   ├── prosemirror-schema.js # The single ProseMirror schema (marks + nodes)
│   ├── format-registry.js    # Single source of truth for inline-mark syntax
│   │                         #   (delimiters, HTML tags, style props) + derived
│   │                         #   tolerant-parser metadata
│   ├── svg-sanitizer.mjs     # Strict SVG sanitize policy (shared by editor + server)
│   └── markdown/             # Markdown → ProseMirror parser
│       ├── index.js          # markdownToPm(md, diffMark, { strict }) dispatch
│       ├── strict-parser.js  # Frozen exact-dialect parser (diff engine)
│       └── tolerant/         # Tolerant CommonMark + GFM subset parser
├── migrations/               # Database migrations
├── script/                   # Utility scripts
│   ├── generate-mcp-secrets.sh  # Generate MCP OAuth secrets
│   ├── edit-default-doc.js      # Example programmatic editing
│   ├── jest-llm-reporter.js     # Compact Jest reporter for LLM contexts
│   └── vitest-llm-reporter.mjs  # Compact Vitest reporter for LLM contexts
├── docs/                     # Documentation
│   ├── mcp-quickstart.md    # MCP setup guide
│   ├── mcp-integration-summary.md # Complete MCP documentation
│   ├── permissions.md        # Permission system details
│   └── dev.md                # Development environment guide
└── package.json
```

## Data Storage

- **Server**: Documents are persisted to PostgreSQL database
  - **Yjs data**: `yjs_updates` (the append-only update log — the sole source of truth; each row carries its clock, attribution, and write-time `meaningful` classification)
  - **Document metadata**: `documents` table (document info, creator)
  - **Permissions**: `document_shares` table (user-document access with roles)
  - **Users**: `users` table (OAuth user accounts, per-user AI credit allowance)
  - **AI usage**: `ai_usage_log` table (per-request token usage and cost tracking)
  - **AI extra credits**: `ai_extra_credits` table (one-off credit grants with optional expiration)
  - **Search index**: per-document full-text (`tsvector`) and vector embedding columns (`pgvector`, `gemini-embedding-001`, 1536-dim) powering hybrid content search; refreshed by a background indexer as documents change. The full-text row also stores a `content_hash` (SHA-256 of the extracted body text) that gates embedding regeneration — unchanged text skips the provider entirely, and the hash only advances atomically with a successful chunk swap (or the empty-content chunk cleanup). Chunk rows record `embedding_model` explicitly; the boot-time repair pass re-indexes documents that are missing, edit-stale, or carry a different model
  - Schema is managed via migrations (see Database Migrations section below)
- **Client**: Changes are cached in browser IndexedDB for offline support

### Database Backups

A Kubernetes CronJob performs nightly PostgreSQL backups to a dedicated,
hardened S3 bucket:

- **Schedule**: Nightly at 9:38 AM UTC
- **Storage**: `s3://squiredocs-db-backups/` — SSE-KMS, versioning, Object Lock
  (governance, 30-day retention), lifecycle to Glacier IR, block-all-public
- **Naming**: `collab-postgres-<hostname>-<arch>-<timestamp>.sql.gz` (timestamped
  so a corrupt dump can never overwrite a good one)
- **Job posture**: runs non-root from a pinned image (no runtime `apk add`), reads
  the DB password from a mounted file (never argv/traced), uploads with a scoped
  `squiredocs-db-backup-writer` credential, and a CloudWatch dead-man alarm emails
  if no backup lands in 26h

Full backup and restore operations — including why the uploader uses AWS CLI v2
(s3cmd is incompatible with Object Lock) and the rehearsed restore procedure — are
in [docs/operations.md](docs/operations.md#backups--data-protection). The legacy
shared node backed up to the shared `earthquaketracksql` bucket; that is
superseded.

## Database Migrations

This project uses [node-pg-migrate](https://github.com/salsita/node-pg-migrate) for database schema management.

### Running Migrations

The standard way to run migrations is using node-pg-migrate's CLI:

```bash
# Run all pending migrations (up)
npm run migrate
# or: npx node-pg-migrate up

# Rollback last migration (down)
npm run migrate:down
# or: npx node-pg-migrate down

# Create a new migration file
npm run migrate:create migration_name
# or: npx node-pg-migrate create migration_name

# Redo last migration (down then up)
npm run migrate:redo
# or: npx node-pg-migrate redo
```

**Note:** node-pg-migrate requires the database to already exist. It only manages schema within the database, not database creation itself.

### Migration Files

Migration files are located in the `migrations/` directory. Each migration file exports `up` and `down` functions:
- `up`: Applies the migration
- `down`: Rolls back the migration

Example migration structure:
```javascript
exports.up = (pgm) => {
  pgm.createTable('my_table', {
    id: 'id',
    name: { type: 'varchar(100)', notNull: true },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('my_table');
};
```

## Troubleshooting

### WebSocket Connection Issues

- Ensure the server is running on the correct port
- Check firewall settings if accessing remotely
- Verify `VITE_WS_URL` matches your server URL

### Port Already in Use

Change the port using the `PORT` environment variable:
```bash
PORT=3002 npm start
```

### Database Connection Errors

If you encounter database connection errors:

1. **Check PostgreSQL is running:**
   ```bash
   # macOS (Homebrew)
   brew services list
   
   # Linux
   sudo systemctl status postgresql
   ```

2. **Verify database exists:**
   ```bash
   psql -l | grep collab_db
   ```

3. **Check connection credentials:**
   - Verify environment variables match your PostgreSQL setup
   - Test connection manually:
     ```bash
     psql -h localhost -U postgres -d collab_db
     ```

4. **Reinitialize schema if needed:**
   ```bash
   npm run init-db
   ```
   
   Or run migrations directly:
   ```bash
   npm run migrate
   ```

## Development Notes

- **Authentication**: Google OAuth required for all users
- **Document Management**: Full CRUD with permission-based access control
- **Multi-document**: Users can create and manage multiple documents
- **Permission System**: Centralized RBAC enforcement (see `server/permissions.js`)
- **UI Features**: Word processor-style editor with visible margins, share badges, and role-based UI
- **Google Analytics**: The gtag.js snippet is duplicated in `client/index.html` (SPA entry) and each static marketing page (`client/public/landing.html`, `pricing.html`, `about.html`). If you update tracking IDs, change all of them.
- **Static marketing pages**: `client/public/` holds the public marketing pages — `landing.html` (`/`), `pricing.html` (`/pricing`), `about.html` (`/about`) — sharing `client/public/marketing.css`. They're routed by the `staticPagesPlugin` in `client/vite.config.js` (dev) and explicit Express routes in `server/index.js` (prod); all other unknown paths fall through to the React SPA. Privacy/Terms remain React pages (`client/src/pages/`).

### ⚠️ Security: User Ownership Checks on All Data Access

**CRITICAL:** Every server-side query that reads or mutates a user-owned resource **must** include the authenticated user's ID in its WHERE clause. Never look up a record by its primary key alone — always scope to the owning user.

```javascript
// ❌ WRONG - Allows any authenticated user to access any record by ID
const result = await pool.query('SELECT * FROM chats WHERE id = $1', [chatId]);

// ✅ CORRECT - Enforces ownership at the database level
const result = await pool.query('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, userId]);
```

**Why this matters:**
- Without ownership checks, any authenticated user who obtains or guesses a record ID can read, modify, or delete another user's data (IDOR vulnerability)
- Client-side checks are not a substitute — the server must enforce authorization
- Random/unguessable IDs are defense-in-depth, not a replacement for proper authorization

**Where to check:**
- `server/chat-store.js` — all chat CRUD operations require `userId`
- `server/permissions.js` — document access uses the `document_shares` table
- `server/api/admin.js` — admin endpoints use `requireAdmin` middleware with DB verification
- Any new API endpoint that accesses user-owned data

**When adding new endpoints or data stores**, ensure:
1. The SQL query includes `AND user_id = $N` (or equivalent ownership join)
2. The route handler passes `req.user.userId` to the data layer
3. Non-matching queries return 404, not the other user's data

**For HTML email templates**, always escape user-controlled values with `escapeHtml()` before interpolation (see `server/email.js`).

### ⚠️ Common Pitfall: Y.XmlText Methods

**CRITICAL:** When working with `Y.XmlText` nodes that may contain formatting (bold, italic, etc.), always use `toDelta()` to extract plain text, **never** `toString()`.

```javascript
// ❌ WRONG - toString() returns XML markup when text has formatting
const text = xmlTextNode.toString();  // Returns "<bold>Hello</bold> world"

// ✅ CORRECT - toDelta() returns plain text regardless of formatting
const delta = xmlTextNode.toDelta();
const text = delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');  // Returns "Hello world"
```

**Why this matters:**
- `toString()` returns XML serialization like `<bold>text</bold>` when formatting is present
- This causes incorrect text length calculations and position offsets
- Results in formatting being applied at wrong locations or complete failures
- Particularly affects `find` + `format` operations after text has been formatted

**Where to check:**
- Any function that traverses or counts text characters
- Position/offset calculations in `cursor-operations.js`
- Text extraction in `text-operations.js`
- Find/search operations

See `server/mcp/yjs/cursor-operations.js` (getAllText function) and `server/mcp/yjs/text-operations.js` (extractText function) for correct examples.

## UI/UX Features

### Editor Interface
- **Word processor styling**: Visible margins with thin grey lines, centered content area
- **Header layout**: Document icon, title input, and formatting toolbar aligned vertically
- **Keyboard navigation**: Tab key moves focus from title to editor content
- **Format buttons**: Square buttons with hover/active states, styled letters (B/I/U/S)

### Document List
- **Share badges**: Visual indicators for shared documents (green = shared with me, purple = I shared)
- **Date format**: Shows "Opened [date time]" for all documents
- **Quick actions**: 3-dot menu with Share and Delete options
- **Refresh**: Click document icon next to "Documents" title to refresh list

### Sharing Interface
- **Share dialog**: Shows document title, lists all users with access
- **User autocomplete**: Typing in the email field suggests matching registered users (name + avatar); excludes the current user and people already on the doc
- **Invite by email**: Sharing with an address that isn't a registered user yet creates a pending invite (shown under "Pending invites") and emails them an invitation. The invite converts to a real share on their first sign-in. Pending invites can be cancelled by editors/owners
- **Role management**: Visual role badges, dropdown selectors for role changes
- **Permission hints**: Disabled actions show tooltips explaining restrictions

## Testing

Comprehensive test suite with Jest (backend) and Vitest (frontend).

**Running tests in the dev pod** (recommended — matches the CI environment; see [docs/dev.md](docs/dev.md) for full setup):

```bash
# Backend tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm test"

# Frontend tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev/client && npm test"

# All tests
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run test:all"
```

**Running tests locally** (if you have Node 22+ and PostgreSQL):

```bash
npm test              # Backend tests
npm run test:client   # Frontend tests
npm run test:all      # All tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage
cd client && npm run test:coverage
cd client && npm run lint:colors  # Dark-mode token gate: fails on hardcoded color literals in themed CSS
```

**Test Structure:**
- `server/__tests__/` - Server and WebSocket tests
- `client/src/**/__tests__/` - Component and hook tests
- `__tests__/integration/` - End-to-end collaboration tests
- `client/src/test/utils.jsx` - Shared test utilities and mocks

**LLM-friendly test reporters:** Custom reporters (`script/jest-llm-reporter.js` for Jest, `script/vitest-llm-reporter.mjs` for Vitest) compress passing-suite output to a single summary line, expanding details only on failure. This reduces output from thousands of lines to a compact summary suitable for LLM context windows.

## Documentation

For more detailed information, see:

- **[MCP Quickstart](docs/mcp-quickstart.md)** - Get started with AI agent integration
- **[MCP Integration Summary](docs/mcp-integration-summary.md)** - Complete MCP feature documentation
- **[Permissions Guide](docs/permissions.md)** - Permission system details and role-based access control
- **[Development Guide](docs/dev.md)** - Development environment setup and best practices
- **[MCP Auth Production Plan](docs/mcp-auth-production-plan.md)** - OAuth 2.0 implementation for production

## License

MIT

