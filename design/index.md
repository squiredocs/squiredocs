<!-- source: https://squiredocs.com/d/f8f3a2ee-31bb-4d80-8306-25e186810885
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Design Docs — Index

Ground-truth design documents for the Squire codebase (`samg/collab`). Each doc here is exported to `design/` in the repo by `node design/sync.mjs`. Design changes are made in these Squire docs first, then re-exported, then code is converged to match — exports are never hand-edited. See the `/design-pipeline` skill in the repo for the full operating model.

## Documents

| Design doc | Repo path | Status |
| --- | --- | --- |
| [Proposal: Markdown Import & Two-Way Repo Sync](https://squiredocs.com/d/b6edb804-cf72-416d-9c97-063a23e669c0) | `design/markdown-import-two-way-sync.md` | Draft for review |
| [Squire Design Docs — Index (this doc)](https://squiredocs.com/d/f8f3a2ee-31bb-4d80-8306-25e186810885) | `design/index.md` | Living |

**Adding a doc: **create it in Squire, add a row to this table, and add its guid to the `DOCS` map in `design/sync.mjs`.