<!-- source: https://squiredocs.com/d/f7476460-5c97-422d-bf5f-ef0c4a1ad048
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Architecture Design Index

A single entry point to the Squire architecture docs in this system. Grouped by area; each doc describes the _current implementation_ with pointers into the code. Start with the Collaboration Core, then drill into the document model, the agent surface, and platform concerns. These docs are ground truth for the repo — each is exported to `design/` by `node design/sync.mjs` (see the Repo Sync Manifest below); design changes happen here first, then re-export, then code converges. Exports are never hand-edited.

## Collaboration Core

- [Squire Collaboration Core](https://squiredocs.com/d/396c4ec7-9db5-4f91-b0c6-8c5faa9f0f65) — real-time sync (Yjs + y-websocket), Postgres persistence and the clock, offline support, presence, version history
- [Squire Document Model and Format Pipeline](https://squiredocs.com/d/6e425e03-1670-4773-987a-584d3d04dea3) — the ProseMirror schema, the format registry as single source of truth, markdown serialization, and version diffs

## Agent Surface

- [Squire Agent Surface (MCP)](https://squiredocs.com/d/697456a2-b42b-49b3-ae57-875d3e328809) — the MCP tool surface, the sandboxed modify pipeline, OAuth and API tokens, the REST export API, attribution
- [Squire In-App AI Assistant](https://squiredocs.com/d/75b5055d-f4f8-4b3c-8955-f6c3f7841fc7) — the chat panel and chat-centric mode, multi-provider model dispatch, BYOK, credits, onboarding

## Platform

- [Squire Authentication and Sharing](https://squiredocs.com/d/503fb6a8-d165-49c7-bc98-883a68b14540) — Google OAuth and JWTs, document roles and permission enforcement, sharing, the admin area
- [Squire Content Search](https://squiredocs.com/d/187b0da3-1004-4273-82f8-062f6a903f14) — hybrid full-text + pgvector semantic search fused with Reciprocal Rank Fusion
- [Squire Media and Diagram Blocks](https://squiredocs.com/d/9bb17cdc-0b56-4c87-8b4e-d3686029cb8a) — the S3 image pipeline and app-URL indirection, Mermaid/SVG blocks and the sanitization policy
- [Squire UI Theming and Dark Mode](https://squiredocs.com/d/43a8653c-28f0-4598-9f92-9122ba686883) — the semantic color-token layer, Light/Dark/System appearance selection, the light "paper" document canvas, AA contrast
- [Squire Product Documentation Site](https://squiredocs.com/d/247d3036-14c5-4f6e-adc6-b90f36cc80d8) — the public product documentation pages under /documentation/: markdown sources in the repo, build-time static rendering, and the docs vs documentation terminology standard

## Infrastructure

- [Squire Infrastructure and Environments](https://squiredocs.com/d/c97e58df-4104-4e5d-8ab6-711a7b115696) — production k3s, the Minikube dev pod, deploy scripts, Redis, migrations, and the test infrastructure

## Design Proposals

- [Proposal: Markdown Import & Two-Way Repo Sync](https://squiredocs.com/d/b6edb804-cf72-416d-9c97-063a23e669c0) — generalize the markdown parser, expose import, and sync repo files as an offline CRDT collaborator (draft)

## Repo Sync Manifest

| Design doc | Repo path | Status |
| --- | --- | --- |
| Squire Architecture Design Index (this doc) | `design/index.md` | Living |
| Squire Collaboration Core | `design/collaboration-core.md` | Current implementation |
| Squire Document Model and Format Pipeline | `design/document-model-format-pipeline.md` | Current implementation |
| Squire Agent Surface (MCP) | `design/agent-surface-mcp.md` | Current implementation |
| Squire In-App AI Assistant | `design/in-app-ai-assistant.md` | Current implementation |
| Squire Authentication and Sharing | `design/authentication-and-sharing.md` | Current implementation |
| Squire Content Search | `design/content-search.md` | Current implementation |
| Squire Media and Diagram Blocks | `design/media-and-diagram-blocks.md` | Current implementation |
| Squire UI Theming and Dark Mode | `design/ui-theming-dark-mode.md` | Ratified design |
| Squire Infrastructure and Environments | `design/infrastructure-and-environments.md` | Current implementation |
| Proposal: Markdown Import & Two-Way Repo Sync | `design/markdown-import-two-way-sync.md` | Draft for review |
| Squire Product Documentation Site | `design/product-documentation-site.md` | Ratified design |

**Adding a doc: **create it in Squire, add it to the area listing above and this manifest, and add its guid to the `DOCS` map in `design/sync.mjs` (the map is what the sync actually executes; this table is the human-readable mirror).