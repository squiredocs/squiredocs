# Implementation Plan: Self-Host Configuration Foundation

**Branch**: `058-self-host-config` (spec directory; work happens on the orchestrated branch, no feature branch) | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/058-self-host-config/spec.md`, ledger `clarifications-needed.md` (RBD-058-1 to RBD-058-32), design `design/self-hosting-local-mode.md` (ratified, D1 to D12, amended 2026-10-07).

## Summary

Make the Squire Docs image boot with no environment variables beyond the
database, while the hosted service keeps running from the same image with no
observable change. The approach: one instance-configuration module resolves
`APP_URL`, `SQUIRE_HOSTED`, the storage driver, the data directory,
migrate-on-boot, and SMTP once; a new entrypoint generates and persists the
four secrets and runs migrations under an advisory lock before it requires
`server/index.js`; the cookie `Secure` flag follows `APP_URL`'s scheme; image
bytes go through a storage facade with `local` and `s3` drivers and new
cookie-authenticated raw routes; every hosted-only surface is gated on
`SQUIRE_HOSTED`; and text that names the server is built from the request
origin or `APP_URL`. The production overlay sets four explicit values so the
hosted service depends on no new default.

**Migration**: none. This feature adds no node-pg-migrate migration and no
schema change (data-model.md). Feature 059 owns the campaign's migration.

## Technical Context

**Language/Version**: Node.js 22 (CommonJS server), React 18 + Vite client

**Primary Dependencies**: Express, helmet, pg, node-pg-migrate (runtime dep, already in the image), @aws-sdk/client-s3 and s3-request-presigner (existing), nodemailer (existing), dotenv (existing). No new dependency.

**Storage**: PostgreSQL (unchanged schema); new files on the data volume: `secrets.json` and `images/` (data-model.md sections 2 and 3); S3 or S3-compatible when selected

**Testing**: Jest via `npm run test:server` (per-worker database and Redis DB isolation, `DATABASE_URL` is a BASE name), Vitest via `npm run test:client`, `npm run test:first-run`. Image-level checks in `quickstart.md`.

**Target Platform**: Linux container (node:22-alpine, non-root `appuser` uid 100), Kubernetes (k3s prod, Minikube dev), and plain Docker for self-hosters

**Project Type**: Web service (Express API + WebSocket + MCP) serving a React SPA

**Performance Goals**: Healthy within 90 s of container start on a laptop including a full migration (SC-001); raw image route adds one filesystem read per image view; shell injection is done once at mount, not per request

**Constraints**: No user-visible change on the hosted service (US2); secret guards in `jwt.js`, `mcp/auth/jwt.js`, `crypto.js` stay as they are (FR-008); Constitution VII (no single-replica precondition: the lock makes boot migrations safe with N replicas, and the local driver is documented as single-node like the compose file it serves); minimal edits to `server/auth/routes.js`, `server/auth/google.js`, and `client/src/components/LoginPage.jsx`, which feature 059 rewrites next

**Scale/Scope**: About 30 source files touched, 9 new modules, 13 test files whose `jest.mock` path moves, 3 Kubernetes files, the Dockerfile

## Constitution Check

*GATE: evaluated before Phase 0 and re-checked after Phase 1. Result: PASS, no Complexity Tracking entries.*

| Principle | How the plan complies |
| --- | --- |
| I. Documentation Reflects Reality | README, `docs/dev.md`, and `.env.example` updates are tasks in the same change (list below). This agent may not edit README or `docs/dev.md`; the implementer does, in the same commit as the behavior. |
| II. Test-Backed Changes, isolation invariant | Every FR in FR-038 has a task. Routes that today live only inside `server/index.js` (image upload and resolve, pages, CSP) move into modules the tests mount, so tests exercise production code instead of mirrors. The migrate-lock test uses the worker's own database. Test setup gives each worker its own `SQUIRE_DATA_DIR`. Rows created by tests are cleaned by their ids (`doc_guid` for documents) in the suite that creates them. |
| III. Trunk-Based Solo Workflow | No new process. |
| IV. Collaboration-Safe Document Operations | Welcome-document seeding keeps its node-builder path; only the template's URLs and two hosted-only nodes change. No delete-and-recreate. |
| V. Secure by Default | New raw routes enforce auth and document ACL (or attachment ownership), serve only allow-listed image types with `nosniff` and a sandbox CSP, and reject keys that escape the store. Trust boundary stated in `contracts/http-routes.md`. Secrets file mode 0600, never regenerated on corruption. Cookie `Secure` follows the public scheme; the plain-http-remote case logs a warning (RBD-058-13). Development endpoints remain behind `ENABLE_DEV_ENDPOINTS=1`, which the image never sets. |
| VI. Design Docs Are Ground Truth | The plan follows the amended design where it differs from the spec (`APP_URL` chain, RBD-058-18). Design amendments the implementation should carry back are listed below; no export is hand-edited. |
| VII. Horizontally Scalable App Pods | Advisory lock makes migrate-on-boot safe for N replicas. The hosted service keeps env secrets and S3, so nothing changes for its two pods. Generated secrets and local images are volume state, not process memory: N replicas are correct when they share `SQUIRE_DATA_DIR` (first-boot secret creation is race-safe through an exclusive link, research R4) or use env secrets plus `STORAGE_DRIVER=s3`. Per-replica private volumes are a misconfiguration the docs name (RBD-058-31). No correctness-bearing process memory added. |

Post-design re-check: PASS. The only structural additions (facade, router
extraction, config module) each remove a test mirror or a scattered env read,
so none needs a Complexity Tracking entry.

## Project Structure

### Documentation (this feature)

```text
specs/058-self-host-config/
├── spec.md
├── clarifications-needed.md   # RBD-058-1 to 32
├── promotion-notes.md
├── plan.md                    # this file
├── research.md                # R1 to R14
├── data-model.md              # in-process config, secrets file, local store (no schema)
├── quickstart.md
├── contracts/
│   ├── environment.md
│   ├── http-routes.md
│   └── storage-and-boot.md
└── tasks.md
```

### Source Code (repository root)

```text
Dockerfile                                  # ENV, /data, HEALTHCHECK /ready, CMD entrypoint
script/entrypoint.js                        # NEW thin launcher
server/
├── instance-config.js                      # NEW resolve once; hostedOnly
├── boot/
│   ├── entrypoint.js                       # NEW main(): dotenv → config → secrets → migrate → server
│   ├── secrets.js                          # NEW
│   └── migrate-lock.js                     # NEW
├── image-storage/
│   ├── index.js                            # NEW facade
│   ├── s3-driver.js                        # MOVED from server/s3-images.js (+ S3_ENDPOINT, readObject)
│   └── local-driver.js                     # NEW
├── s3-images.js                            # DELETED
├── app-shell.js                            # NEW instance config + analytics injection
├── web-routes.js                           # NEW CSP directives, pages, shell, agents.md
├── api/document-images-routes.js           # NEW upload/resolve moved from index.js + raw
├── index.js                                # wires the above; redirect gate; email boot log; storage facade
├── auth/jwt.js                             # cookie Secure from config
├── auth/routes.js                          # 3 transient cookies; hostedOnly on prod reset; CLIENT_URL from config
├── auth/google.js                          # redirect URI from config
├── auth/middleware.js                      # requireAuthOrCookie
├── url.js                                  # PUBLIC_ORIGIN default from config
├── email.js                                # SMTP config; hosted gate on notifyNewUser/notifyLogin
├── ai-usage.js                             # checkQuota notApplicable when not hosted
├── api/admin.js                            # hostedOnly on welcome-email; 503 text
├── api/ai-providers.js                     # OpenRouter referer from APP_URL
├── api/chat-attachments.js                 # facade; local resolve URL; raw route
├── api/chat.js, api/chat-tools.js, api/docs-export.js,
│   document-images.js, image-rehost.js, mcp/image-validate.js   # require the facade
├── mcp/tools/tool-documentation/export-api.js, tool-documentation/index.js,
│   get-tool-documentation.js, create-access-token.js, import-markdown-file.js
├── onboarding/welcome-template.js, onboarding.js
└── __tests__/ (setup.js + new suites; mock paths)
client/
├── index.html                              # analytics snippet removed
├── vite.config.js                          # shell injection + gated marketing plugin in dev
└── src/instance.js (NEW), App.jsx, components/LoginPage.jsx,
    pages/SettingsPage.jsx, pages/AdminPage.jsx
k8s/overlays/aws-prod/patches/app-self-host-config.yaml   # NEW
k8s/overlays/aws-prod/kustomization.yaml
k8s/overlays/minikube/patches/app-self-host-config.yaml   # NEW
k8s/overlays/minikube/kustomization.yaml
k8s/overlays/minikube/app-dev.yaml
devcontainer/k8s/app-dev.yaml
.env.example, .gitignore, README.md, docs/dev.md
```

**Structure Decision**: Existing single-repo web layout (`server/`, `client/`,
`k8s/`, `script/`). New server code goes in small modules beside the code it
replaces; boot code lives under `server/boot/` so Jest collects it, with a
one-line launcher in `script/`.

## Phases

**Phase A, foundation (blocks everything)**: `server/instance-config.js` with
its unit suite; test setup normalization (`SQUIRE_DATA_DIR` per worker, unset
`SQUIRE_HOSTED`, `APP_URL`, `STORAGE_DRIVER`, `SMTP_*`).

**Phase B, US1 boot (P1)**: secrets, migrate lock, entrypoint, Dockerfile, the
ordering test.

**Phase C, US2 hosted parity (P1)**: overlay patches; existing suites that
assert hosted behavior set `SQUIRE_HOSTED=true`; a hosted-parity suite that
asserts every hosted surface with the flag on.

**Phase D, US3 URL and cookies (P2)**: `jwt.js`, `routes.js`, `google.js`,
`url.js`, CORS in `index.js`, the http warning.

**Phase E, US4 storage (P2)**: facade and drivers, consumer and mock-path
switch, router extraction, raw routes, chat attachment raw route.

**Phase F, US5 hosted gating and server-naming text (P3)**: CSP and pages
module, app shell, Vite, client flag and UI, admin endpoints, quota, emails,
redirect, referer, MCP text, welcome template, `/agents.md`.

**Phase G, US6 SMTP (P3)**: transport resolution and boot log.

**Phase H, polish**: docs, design-amendment requests, full suites, promotion
notes.

## Hosted deploy changes (exact values)

| File | Change |
| --- | --- |
| `k8s/overlays/aws-prod/patches/app-self-host-config.yaml` (new) | Strategic-merge patch on Deployment `collab-app`, container `collab-app`, env: `SQUIRE_HOSTED="true"`, `MIGRATE_ON_BOOT="false"`, `APP_URL="https://squiredocs.com"`, `STORAGE_DRIVER="s3"`. Plain values, not secrets. |
| `k8s/overlays/aws-prod/kustomization.yaml` | Add `- path: patches/app-self-host-config.yaml` to `patches`, with a comment naming feature 058 and FR-036. |
| `k8s/overlays/aws-prod/patches/app-node-env.yaml` | Comment only: `NODE_ENV=production` is now also the image default; the patch stays as belt and braces. No value change. |
| `k8s/overlays/minikube/patches/app-self-host-config.yaml` (new) | Patch on `collab-app` env: `SQUIRE_HOSTED="true"`, `MIGRATE_ON_BOOT="false"` (mirror production; the migrate Job keeps running). `STORAGE_DRIVER` left to auto-detect. |
| `k8s/overlays/minikube/kustomization.yaml` | Add the patch; update the header comment (the base pod now runs `NODE_ENV=production` from the image, RBD-058-15). |
| `k8s/overlays/minikube/app-dev.yaml` and `devcontainer/k8s/app-dev.yaml` | Add env `SQUIRE_HOSTED="true"` to the app-dev pod in both files (the devcontainer copy is the one the sandbox actually runs; RBD-058-28). `NODE_ENV=development` stays. |
| `k8s/base/*` | No change. The base migrate Job and probes are untouched. |
| `script/deploy-aws.sh`, `script/build-and-deploy-aws.sh`, `script/deploy.sh` | No change. `MIGRATE_ON_BOOT=false` leaves migrations to the Job and its pause-gate. |
| `k8s/secrets/*.enc.yaml` | No change. `CLIENT_URL`, `GOOGLE_REDIRECT_URI`, the four secrets, and `SES_*` keep names and values. |
| `Dockerfile` | `ENV NODE_ENV=production SQUIRE_DATA_DIR=/data MIGRATE_ON_BOOT=true`; `/data` owned by `appuser`; `HEALTHCHECK` on `/ready` with `--start-period=90s`; `CMD ["node","script/entrypoint.js"]`. Kubernetes ignores `HEALTHCHECK`; the migrate Job's `command:` overrides `CMD`. |

Maintainer verification owed before the first hosted deploy: render both
overlays (quickstart step 6); confirm minikube `k8s/auth.env` and the MCP
secret hold strong non-default values (the base pod now refuses weak secrets).

## Documentation updates the implementer must make (Constitution I)

This planning agent may not edit these; they are tasks T061 to T063.

- `README.md`: environment variable table per `contracts/environment.md`
  (new: `APP_URL`, `SQUIRE_HOSTED`, `SQUIRE_DATA_DIR`, `MIGRATE_ON_BOOT`,
  `STORAGE_DRIVER`, `S3_ENDPOINT`, `SMTP_*` with the `SES_*` aliases; changed
  defaults for `CLIENT_URL`, `GOOGLE_REDIRECT_URI`, `PUBLIC_ORIGIN`); the boot
  order (entrypoint, secrets, migrations, server); the secrets file and the
  warning that losing the volume loses the BYOK encryption key; the production
  overlay values; remove `JWT_SECRET` from the variable list (RBD-058-17); the
  raw image routes; hosted-only gating; more than one replica needs a shared
  data volume or env secrets plus `STORAGE_DRIVER=s3` (RBD-058-31).
- `docs/dev.md`: `npm run dev` still runs `server/index.js` directly; the app-dev
  pod sets `SQUIRE_HOSTED=true` (flip it to exercise self-host mode); set
  `SQUIRE_DATA_DIR=/local-dev/.squire-data` to try the local driver; the test
  setup forces `SQUIRE_HOSTED` unset and a per-worker `SQUIRE_DATA_DIR`, so a
  suite that needs hosted behavior sets it before requiring modules; the
  minikube base pod now boots in production mode.
- `.env.example`: every variable above with its default, keeping
  `CLIENT_URL=http://localhost:5173` for development (RBD-058-30).
- `.gitignore`: `/.squire-data/`.

## Design amendments to request (Constitution VI; amend in Squire, then `node design/sync.mjs`)

1. Spec FR-009 and RBD-058-1 still name `SQUIRE_PORT`; the amended design does
   not. The spec should be synced to the design (RBD-058-18).
2. "Generic SMTP" bullet: add the port and TLS rule and that the SES default
   host applies only through the `SES_*` aliases (RBD-058-8).
3. "Local image storage" bullet: raw routes accept the session cookie
   (RBD-058-20); multi-replica self-host needs `STORAGE_DRIVER=s3`.
4. "Hosted-only features" bullet: add the welcome document's beta-credit
   sentence (RBD-058-22).

## Risks

| Risk | Mitigation |
| --- | --- |
| A consumer still requires the deleted `server/s3-images.js` | Deleting the file makes any missed require fail loudly; a guard test greps for driver requires outside the facade. |
| A test mock path is not updated and a real driver runs | Per-worker temp `SQUIRE_DATA_DIR`; `STORAGE_DRIVER` unset in setup and the app-dev pod's S3 vars ignored unless a suite opts in. |
| Raw route 401 because the access cookie expired | Resolve call refreshes first; failure mode equals today's expired presigned URL. |
| Hosted analytics snippet drifts while moved | `server/__tests__/app-shell.test.js` asserts the hosted shell contains the exact `G-9HGTDJRJWH` and `AW-18023084061` config lines in `<head>` before any other script. |
| 059 merge conflicts in `routes.js`, `google.js`, `LoginPage.jsx` | 058 edits there are a handful of lines each; gating for emails sits in `email.js`. |
| Entrypoint loads `pg` before OpenTelemetry hooks install, losing DB tracing | Entrypoint calls the idempotent `telemetry.start()` first; `pg` required lazily (RBD-058-32). |
| Minikube base pod crash-loops on weak secrets | Verification item before rebuild (RBD-058-15). |

## Complexity Tracking

None. No constitution violation needs justification.
