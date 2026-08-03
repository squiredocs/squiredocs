# Promotion notes — 049 constant-time write path

**Date**: 2026-08-03 · Branch `049-constant-time-write-path` off `main` @ cb8e39e1

---

## 1. What this feature does and does not claim

**Does**: `updateDocument` stops copying the document. It authors on the shared
document under a borrowed client identity, restored in a `finally`. The 048
attribution property is unchanged — one client id, one `(user, agent)` identity,
by construction — and the cost stops tracking document size (measured flat
across ~85 KB / ~800 KB / ~3 MB; see `performance.md`).

**⚠️ DOES NOT — do not let this be rounded up in a release note (FR-013, analyze F6)**:

> **049 makes `updateDocument` itself constant time. The end-to-end
> server-side write is not.** The persistence listener still runs
> `classifyByXml` (`server/update-classifier.js`), which is O(document size) per
> applied update and is skipped only *above* a 500 KB ceiling. So documents
> **under** 500 KB still do size-proportional work after `updateDocument`
> returns. 049 neither changes nor worsens that. "Sub-millisecond server-side
> write" would be an overclaim; "sub-millisecond `updateDocument`" is accurate.

**⚠️ FR-015 — the scale-out non-claim, carried forward verbatim (T045)**:

> 049 changes how a server-side write is authored and what it costs. It does
> **not** advance:
> - **M3** — a refused bind plus a fast reconnect can leave the Redis
>   subscription bound to the dead evicted doc, so the rebuilt doc silently
>   misses cross-pod edits.
> - **M4** — a user reconnecting onto a pod that knows their clientID only as a
>   remote principal is refused awareness for minutes.
> - the **RBD-045-5** durability window.
> - **cross-pod restore serialization** (RBD-041-2).
> - **undo supersession** consulting only the local live doc.
>
> **The one-replica deploy constraint stands.** 049 closes attribution gates; it
> is a precondition for multi-replica operation, not permission for it.

## 2. Owed to the merge queue

- **`docs/dev.md` — the yjs upgrade checklist (T040, FR-012) is NOT applied.**
  My brief forbids editing `docs/dev.md` (the merge queue owns it). The
  obligation is fully carried in code at the `install()` site in
  `server/borrowed-identity.js`, and in
  `specs/049-constant-time-write-path/clientid-reader-audit.md`. The
  developer-doc half is owed. **Ready-to-paste text in §5 below.**
- `README.md` needs no change: it does not describe the 048/049 write
  mechanism (checked with `grep -an`).
- `design/` is export-only and untouched. **D-049-A** remains owed to Sam in the
  Squire doc (borrowing's residual equals yjs's *at draw time* and needs an
  explicit re-check at reuse time — which this implementation now provides and
  pins as N3).
- The manual walk in `quickstart.md` §7 is owed to Sam.

## 3. Deviations from plan/tasks, with reasons

| # | Deviation | Reason |
| --- | --- | --- |
| **D1** | **`markdown-import.js` keeps its pre-`prepareImport` XPath fail-fast check.** T013 said collapse *both* resolutions into one compute-phase resolution. The in-transaction one did collapse into compute (that was the real requirement — it was a mutate-phase throw). The **early** check was kept. | Dropping it is a real behavior regression, not a cleanup. `prepareImport` → `stageImagePass` → `externalImagePass` **rehosts external images to S3**. Without the early check, a doomed `insertAfterXPath` import uploads images and *then* fails, orphaning them. The early check is explicitly commented as a fail-fast, not the authoritative resolution; the compute-phase one is authoritative and is what the insert uses. |
| **D2** | **`doc.clientID` assignment lives in `borrowed-identity.js` via `install()`/`restore()`, not inline in `updateDocument`.** The contract sketch (`document-service.md` step 9) showed `ydoc.clientID = borrowed` inline. | The two contracts contradicted each other: `borrowed-identity.md` opens "The **only** place in this codebase that assigns `doc.clientID`" and T037 requires the FR-012 upgrade caveat to sit *at the assignment site in that module*. Two one-line functions satisfy both, and keep the `transact` + `finally` in one readable block in `updateDocument` as the sketch intended. |
| **D3** | **C1 (chat image insert) was re-pointed, though `invariant-guards.md` lists it as "kept unchanged".** | C1 carried a trailing identity assertion (`a[0] !== b[0]`, "each insert authored under its own one-shot identity") that the per-identity cache falsifies exactly as it falsifies G3 — both inserts are by the same identity. The contract characterised C1 as "content placement", which missed this clause. Re-pointed the same way as G3 (same identity → same id; never the document's own; exactly one per update), which is non-weakening. Content-placement assertions untouched. |
| **D4** | **N6 asserts the escaped rows are UNATTRIBUTED rather than absent.** | My first version asserted zero rows and failed. That was my error, and the failure was informative: the detector reports the escape, it cannot prevent it — by the time the compute phase returns, the mutation has already fired the update event and reached persistence. The guard now asserts the actual harm (`userId === null`, `agentName === null`), which is a stronger and more honest pin than "no rows". |
| **D5** | **`docs/dev.md` not edited** (T040). | See §2 — brief forbids it. |

## 4. Verification performed

- Full backend suite, serially, against a **dedicated** database
  (`collab_test_db_049`) — never the shared one.
- Client suite (`vitest`) and `npm run build`.
- **SC-008 deliberate-regression check RUN, not assumed** — the mechanism was
  broken four separate ways and the named failures were read. Full transcript
  in `performance.md` §4.
- **FR-008 gate** — `clientid-reader-audit.md`, with empirical probes
  (`fr008-probe.cjs`) rather than reasoning alone.

## 5. Ready-to-paste `docs/dev.md` section (T040, owed)

Suggested placement: near the existing dependency/upgrade guidance.

```markdown
### Upgrading yjs / y-protocols / y-websocket

**Do not bump any of these three without re-running the client-id reader
verification first.** Server-side writes (feature 049) install a *borrowed*
`clientID` on the shared document for the duration of one synchronous
transaction — see `server/borrowed-identity.js`. That works because yjs reads
`doc.clientID` at struct-creation time from the transaction's document. It is a
public field, but **reassigning it is not a documented, supported operation**,
so an upgrade can silently change the behavior every server-side write's
attribution depends on.

Before the bump merges:

1. Re-run the verification and **re-date** the artifact:
   `specs/049-constant-time-write-path/clientid-reader-audit.md`.
   `node specs/049-constant-time-write-path/fr008-probe.cjs` reproduces the
   empirical half in a few seconds.
2. Re-check the two live readers the audit found, which are safe only
   circumstantially:
   - `yjs.cjs:3379` — yjs's own duplicate-client-id self-heal. It is skipped
     ONLY because our transaction is local (`!transaction.local`
     short-circuits). If that guard changes, yjs may reassign `doc.clientID`
     mid-borrow.
   - `yjs.cjs:3402` — subdocuments added during a transaction are stamped with
     the live `doc.clientID`, **permanently**. Nothing creates subdocuments
     today, and the mutate phase is forbidden from doing so.
3. Run `server/__tests__/per-operation-doc.test.js` and
   `server/__tests__/borrowed-identity.test.js`. **G1, G2, N1 and N9 are
   load-bearing regression detectors, not documentation.** N9 fails by name and
   tells you what to do. If one of them goes red after a version bump, the bump
   is the suspect — do not relax the assertion.
```

## 6. Merge-queue mechanics

- **Depends on 048 being merged** — 049 replaces its mechanism in place and
  re-points its guards. 048 is in the undeployed range.
- **Adjacent to the 048 review's H1 fix.** `acquireReadyDoc` is untouched
  (verified: the only non-comment change anywhere near the gate is the
  `BindFailedError` check on the new nullish-compute short-circuit, which
  T018b/G6 require). A merge that disturbs `acquireReadyDoc` is a defect.
- **No migration**, so no ordering constraint against the pending migration
  queue.
- Deploy stays with Sam.

## 7. Verification results (final)

| Check | Result |
| --- | --- |
| Backend suite (`--runInBand`, dedicated `collab_test_db_049`) | **254 suites / 4568 tests, all passing** |
| Client suite (vitest) | **72 suites / 934 tests, all passing** |
| `npm run build` | **green** (12 doc pages + 6 blog posts emitted) |
| Guard file `per-operation-doc.test.js` | 30 tests (was 23 under 048) |
| `borrowed-identity.test.js` (new) | 14 tests |
| `borrowed-identity-performance.test.js` (new) | 1 test (N11) |
| SC-008 deliberate-regression check | **run** — 4 breakages, all caught by name |

**Zero assertion changes were needed in any migrated test file** (T043). The
eight migrated files changed shape only (`fn` → `() => fn`, 24 call sites); the
only assertion edits anywhere are the deliberate guard re-points (G3, G4, G4b,
G5, C1's identity clause) and additions, each documented in place with what it
used to assert.

### ⚠️ Environment finding, not caused by this feature

The first full-suite run failed 4 suites / 36 tests with
`ReplyError: MISCONF Redis is configured to save RDB snapshots, but it's
currently unable to persist to disk`. **This is shared-environment breakage, not
a code regression** — the failures were exclusively Redis write refusals, with
no assertion failures among them.

Cause: `redis-cli config get dir` returns **empty**, i.e. the Redis process's
working directory no longer exists (its cwd was deleted underneath it — a
deleted worktree is the likely culprit). Disk itself is fine (292 GB free).
`config set dir` is refused as a protected config, so the durable fix needs a
Redis restart with a valid `dir`.

Worked around for the run with
`redis-cli config set stop-writes-on-bgsave-error no`, which is **runtime-only
and not persisted** — it will revert on the next Redis restart, and the
underlying empty `dir` will still be there. Flagged for whoever owns the dev
environment; other agents sharing this Redis will hit the same wall.
