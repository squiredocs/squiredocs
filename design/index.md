<!-- source: https://squiredocs.com/d/f8f3a2ee-31bb-4d80-8306-25e186810885
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Design Docs — Index

Ground-truth design documents for the Squire codebase (`samg/collab`). Each doc here is exported to `design/` in the repo by `node design/sync.mjs`. Design changes are made in these Squire docs first, then re-exported, then code is converged to match — exports are never hand-edited. See the `/design-pipeline` skill in the repo for the full operating model.

## Documents

| Design doc | Repo path | Status |
| --- | --- | --- |
| [Proposal: Markdown Import & Two-Way Repo Sync](https://squiredocs.com/d/b6edb804-cf72-416d-9c97-063a23e669c0) | `design/markdown-import-two-way-sync.md` | Draft for review |
| [Squire Design Docs — Index (this doc)](https://squiredocs.com/d/f8f3a2ee-31bb-4d80-8306-25e186810885) | `design/index.md` | Living |
| [Squire Architecture Design Index](https://squiredocs.com/d/f7476460-5c97-422d-bf5f-ef0c4a1ad048) | `design/architecture-index.md` | Current implementation |
| [Squire Collaboration Core](https://squiredocs.com/d/396c4ec7-9db5-4f91-b0c6-8c5faa9f0f65) | `design/collaboration-core.md` | Current implementation |
| [Squire Document Model and Format Pipeline](https://squiredocs.com/d/6e425e03-1670-4773-987a-584d3d04dea3) | `design/document-model-format-pipeline.md` | Current implementation |
| [Squire Agent Surface (MCP)](https://squiredocs.com/d/697456a2-b42b-49b3-ae57-875d3e328809) | `design/agent-surface-mcp.md` | Current implementation |
| [Squire In-App AI Assistant](https://squiredocs.com/d/75b5055d-f4f8-4b3c-8955-f6c3f7841fc7) | `design/in-app-ai-assistant.md` | Current implementation |
| [Squire Authentication and Sharing](https://squiredocs.com/d/503fb6a8-d165-49c7-bc98-883a68b14540) | `design/authentication-and-sharing.md` | Current implementation |
| [Squire Content Search](https://squiredocs.com/d/187b0da3-1004-4273-82f8-062f6a903f14) | `design/content-search.md` | Current implementation |
| [Squire Media and Diagram Blocks](https://squiredocs.com/d/9bb17cdc-0b56-4c87-8b4e-d3686029cb8a) | `design/media-and-diagram-blocks.md` | Current implementation |
| [Squire Infrastructure and Environments](https://squiredocs.com/d/c97e58df-4104-4e5d-8ab6-711a7b115696) | `design/infrastructure-and-environments.md` | Current implementation |

**Adding a doc: **create it in Squire, add a row to this table, and add its guid to the `DOCS` map in `design/sync.mjs`.