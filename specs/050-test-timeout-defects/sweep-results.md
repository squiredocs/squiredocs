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

---

# Results — measured before/after (T025)

Reference machine: Minikube `app-dev` pod (`app-dev-59d7668b7c-9d2f2`), 10 cores.
Backend runs against the per-worktree database `collab_test_db_050` with
`REDIS_HOST=collab-redis`; `--runInBand` preserved throughout.

## Backend

| Measurement | Before | After | Change |
| --- | --- | --- | --- |
| `document-editing-workflow.test.js` total | **103.538 s** | **6.505 s** | −97.0 s (15.9x) |
| — slowest single test | 10 551 ms | 712 ms | |
| — typical single-modify test | 4 962-5 353 ms | 87-567 ms | |
| — the two two-modify tests | 10 119 / 10 551 ms | 466 / 712 ms | |
| — `undo should succeed` | 4 980 ms | 254 ms | |
| — `redo should succeed` | 4 990 ms | 248 ms | |
| Tests passing | 18 / 18 | 18 / 18 | unchanged |
| Full backend suite (`npm run test:server`) | ~264 s (design baseline) | **175.2 s** | matches the ≈175 s expectation |
| Full backend suite result | — | 254 suites, 4574 passed | green |

Every test is now well under 1 second of durability-wait overhead: the slowest test in
the file is 712 ms *total*, including its sandbox execution (~80 ms/call) and its
document reads. **SC-001 met.**

The ≈175 s backend total is recorded for the design doc's trend table as a
reference-machine expectation, not a gate (RBD-050-4 / G-050-2). It landed on the
number.

## Client

| Measurement | Before | After | Change |
| --- | --- | --- | --- |
| `AiChatContext.banner-persistence.test.jsx` | **14 794 ms** | **439 ms** | −14.4 s (33.7x) |
| — file run alone | 14 715 ms | 358 ms | |
| Vitest wall (full suite, 72 files) | **18.10 s** | **11.06-11.28 s** | −6.9 s |
| Tests passing | 936 / 936 | 936 / 936 | unchanged |

The 18.10 s baseline reproduces the design's 18.2 s figure exactly.

**SC-004 is partially met.** The file target is met decisively (≈1 s asked, 439 ms
delivered, a 34x cut). The "Vitest wall under 10 s" half is **missed by ≈1.1 s** and
cannot be reached by this train — see the note below.

### Why the wall stops at ~11.1 s (SC-004 gate miss)

After the fix, no single test file is slow: the slowest is 2 772 ms and
banner-persistence is 439 ms. The remaining wall is per-file **fixed overhead** spread
across 72 files on 10 workers, not test execution:

```text
Duration 11.28s (transform 3.24s, setup 11.81s, collect 10.53s,
                 tests 29.49s, environment 27.32s, prepare 5.78s)
```

Summed across workers that is ≈52 s of environment/setup/collect/transform against
29.5 s of actual test time — jsdom environment construction and module loading now
dominate. Removing another whole test file would not get under 10 s.

Closing that gap means reducing per-file environment cost or sharding, which is
Train B (§1.3, CI split/cache) and Train C (Part 2, parallel isolation) work, explicitly
out of scope here (FR-009). Recorded rather than worked around: no assertion was
relaxed and no file was excluded to chase the number.

## Measurement note — this machine stalls intermittently

Two readings during verification were gross outliers and were discarded after being
shown non-reproducible:

- a full client baseline run that took **8 m 18 s** wall against only 1 m 40 s of CPU
  (i.e. ~400 s idle), where the identical re-run took 18.6 s;
- a single reading of `binding-selection-writeback.test.js` at **11 166 ms**, which
  measured 240-267 ms in every other run.

Both are host-level stalls, not properties of the suites. Every number in the tables
above was confirmed by repeat runs (the client wall three times: 11.28 / 11.23 /
11.06 s). Anyone re-measuring on this pod should repeat a surprising reading before
believing it.

## Suite-level verification (SC-005, FR-008)

| Command | Result |
| --- | --- |
| `npm run test:server` (LLM reporter, `--runInBand`, `collab_test_db_050`) | **green** — 254 suites, 4574 passed, 175.2 s |
| `npm run test:client` / `npx vitest run` | **green** — 72 suites, 936 passed |
| `npm run test:first-run` | **green** — 31 pass, 0 fail, 3.3 s |

## SC-002 — how it was actually verified

`grep -c editRangePending` on the Jest log reads `0` **both before and after** and is
not a valid gate — the flag is a field on the result object and is never printed. See
promotion-notes.md item 2 and RBD-050-5. SC-002 rests instead on the 20 added in-suite
assertions, which were proven discriminating: with the per-update listener temporarily
neutralized, `modify: append text to existing paragraph` fails at
`expect(result.editRangePending).toBeUndefined()` and takes 5 084 ms again.

## US1 known risk — the record-backed undo/redo path (T014)

Did **not** materialise. `undo should succeed` (254 ms) and `redo should succeed`
(248 ms) both pass. They now exercise the record-backed undo path for the first time —
previously they rode legacy derivation only because every modify timed out and
`recordEdit` landed in the background. Net coverage gain; nothing relaxed.
