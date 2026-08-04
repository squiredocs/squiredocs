# Sweep Results — FR-004 / SC-007 (US3)

**Executed**: 2026-08-04, at implement time, on branch `050-test-timeout-defects`
(worktree `agent-a679dd788774b181c`, app-dev pod).

**Question the sweep answers**: does any backend suite *other than*
`document-editing-workflow.test.js` execute a live `modify` through the tool registry
while registering only snapshot-style (`bindState` load + close-time `writeState`)
persistence — i.e. carry the same pre-016 wiring gap this feature exists to close?

**Scope**: BOTH backend roots, per research R6 and Constitution Principle II —
`server/**/__tests__/` and the repo-root `__tests__/integration/`. (The spec's
spec-time evidence enumerated `server/` only; the commands below cover both, so the
defect class is provably closed rather than closed-by-assumption.)

**Finding**: **no additional offenders.** `document-editing-workflow.test.js` was the
only suite with the gap, and this feature ported it. Every one of the 30 backend test
files that registers persistence installs a per-update `ydoc.on('update', …)` listener;
the snapshot-only filter (b) returns empty. T023 is therefore a no-op — the empty
result is the deliverable.

Note the sweep was run *after* the US1 port, so `document-editing-workflow.test.js`
now classifies as per-update-attributed alongside the rest. Its pre-port state
(snapshot-only) is recorded in the spec's Design-Claim Verification table and in the
baseline measurements below.

---

## Commands and raw output

### (a) Every backend test file registering persistence

```bash
grep -rl "setPersistence" --include=*.test.js server __tests__ | sort
```

```text
__tests__/integration/awareness-spoof-block.test.js
__tests__/integration/collaboration.test.js
__tests__/integration/docs-import-api.test.js
__tests__/integration/docs-import-concurrency.test.js
__tests__/integration/edge-cases.test.js
__tests__/integration/import-recipe-e2e.test.js
__tests__/integration/step2-viewer-block.test.js
__tests__/integration/sync-push.cross-doc-images.route.test.js
__tests__/integration/sync-push.route.test.js
server/__tests__/api-docs-import.test.js
server/__tests__/chat-import-markdown.test.js
server/__tests__/collab-extraction-guard.test.js
server/__tests__/import-presence.test.js
server/__tests__/live-fanout.test.js
server/__tests__/markdown-import.test.js
server/__tests__/onboarding.test.js
server/mcp/__tests__/create-document-markdown.test.js
server/mcp/__tests__/integration/document-editing-workflow.test.js
server/mcp/__tests__/integration/undo-redo-workflow.test.js
server/mcp/__tests__/tools/create-document-teaching.test.js
server/mcp/__tests__/tools/create-document.test.js
server/mcp/__tests__/tools/list-document-versions.test.js
server/mcp/__tests__/tools/modify-conflict-detection.test.js
server/mcp/__tests__/tools/modify-echo.test.js
server/mcp/__tests__/tools/modify-edit-range.test.js
server/mcp/__tests__/tools/modify-from-markdown-rehost.test.js
server/mcp/__tests__/tools/modify-sources.test.js
server/mcp/__tests__/tools/read-document-version.test.js
server/mcp/__tests__/tools/restore-document-version.test.js
server/mcp/__tests__/tools/set-document-title.test.js
```

30 files (21 under `server/`, 9 under the repo-root `__tests__/`) — matching R6's count.

### (b) Of those, any that stores without a per-update listener (snapshot-only)

```bash
for f in $(grep -rl "setPersistence" --include=*.test.js server __tests__); do
  grep -q "storeUpdate" "$f" && ! grep -q "on('update'" "$f" && echo "SNAPSHOT-ONLY: $f"
done
```

```text
(no output — empty)
```

**Empty. This is the deliverable finding (RBD-050-3).**

### (c) Files that reach the registry without registering persistence

```bash
grep -rln "getTool('modify')\|getTool(\"modify\")" --include=*.test.js server __tests__ \
  | xargs grep -Ln "setPersistence"
```

```text
server/mcp/__tests__/tools/tool-modules.test.js
```

One hit, classified **not-applicable** below.

### (d) Supplementary — every file referencing the modify tool by registry lookup

```bash
grep -rln "getTool('modify')\|getTool(\"modify\")" --include=*.test.js server __tests__ | sort
```

```text
server/mcp/__tests__/integration/document-editing-workflow.test.js
server/mcp/__tests__/integration/undo-redo-workflow.test.js
server/mcp/__tests__/tools/modify-conflict-detection.test.js
server/mcp/__tests__/tools/modify-echo.test.js
server/mcp/__tests__/tools/modify-edit-range.test.js
server/mcp/__tests__/tools/modify-from-markdown-rehost.test.js
server/mcp/__tests__/tools/modify-sources.test.js
server/mcp/__tests__/tools/tool-modules.test.js
```

Run in addition to R6's three commands: (b) proves no *persistence-registering* suite is
snapshot-only, but the live-modify set is the population that actually matters, so it is
enumerated and classified explicitly rather than inferred.

---

## Per-file classification

### Suites that execute a live `modify` through the tool registry (7)

All verified to carry the full post-016 pattern: `setPersistence` present, per-update
`ydoc.on('update', …)` listener present, `ORIGIN_DB_LOAD` on the initial apply, and an
identity-attributed `storeUpdate(docGuid, update, userId, agentName)`.

| File | Classification |
| --- | --- |
| `server/mcp/__tests__/integration/document-editing-workflow.test.js` | **per-update-attributed** (ported by this feature; was the sole snapshot-only offender) |
| `server/mcp/__tests__/integration/undo-redo-workflow.test.js` | per-update-attributed |
| `server/mcp/__tests__/tools/modify-conflict-detection.test.js` | per-update-attributed (reference pattern) |
| `server/mcp/__tests__/tools/modify-echo.test.js` | per-update-attributed (reference pattern) |
| `server/mcp/__tests__/tools/modify-edit-range.test.js` | per-update-attributed |
| `server/mcp/__tests__/tools/modify-from-markdown-rehost.test.js` | per-update-attributed |
| `server/mcp/__tests__/tools/modify-sources.test.js` | per-update-attributed |

### Not-applicable (1)

| File | Why |
| --- | --- |
| `server/mcp/__tests__/tools/tool-modules.test.js` | Registry-registration assertion only — `getTool('modify')` is checked for `toBeDefined()` and `.name === 'modify'` (lines 354-356); the handler is never invoked (zero `.handler(` call sites in the file), and no persistence is registered. No durability wait is ever entered. |

### Persistence-registering suites that do not execute a live `modify` (22)

All 22 install a per-update listener regardless, so none could regress into the defect
class even if a live `modify` were added to them later. They exercise import, sync-push,
collaboration, presence, versioning, and `create_document` paths rather than `modify`.

`awareness-spoof-block`, `collaboration`, `docs-import-api`, `docs-import-concurrency`,
`edge-cases`, `import-recipe-e2e`, `step2-viewer-block`,
`sync-push.cross-doc-images.route`, `sync-push.route`, `api-docs-import`,
`chat-import-markdown`, `collab-extraction-guard`, `import-presence`, `live-fanout`,
`markdown-import`, `onboarding`, `create-document-markdown`, `create-document-teaching`,
`create-document`, `list-document-versions`, `read-document-version`,
`restore-document-version`, `set-document-title`.

(`awareness-spoof-block` installs a listener but never calls `storeUpdate` — an
awareness-only harness, not a persistence path. Still not-applicable: no live `modify`.)

---

## Conclusion (FR-004, SC-007)

The pre-016 snapshot-only wiring gap existed in exactly one suite,
`document-editing-workflow.test.js`, which this feature ported (US1). The sweep over both
backend roots finds **no additional offenders**, so the defect class is closed, not merely
the one measured instance. No T023 porting work was required.
