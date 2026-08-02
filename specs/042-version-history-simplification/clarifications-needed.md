# Clarifications Ledger — 042-version-history-simplification

All decisions below are **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** per
the parallel-pipeline mandate: best default chosen, recorded here, nothing decided
silently. Revisit any of these by amending the spec before plan/implement.

---

## DEC-1 — Diff cache-version bump automation: source fingerprint, not CI guard

**Question**: The deep dive (C14) offered two mechanisms: (a) append a derived
source-fingerprint to the cache key namespace, or (b) a CI guard test asserting a
pipeline-source hash so every change forces "bump or ratify". Which one?

**Why it matters**: three manual bumps in three weeks; a forgotten bump serves
stale-shaped cache entries for up to 1 hour.

**Decision**: **(a) source fingerprint in the key namespace** (FR-014).

**Rationale**: the fingerprint eliminates the failure mode — no human step exists to
forget. The CI guard still ends in a human action (bump or ratify) and only moves the
forgetting from runtime to review time. Cost of (a) is a one-time cache invalidation
whenever pipeline source changes, which is exactly the intended semantics for a 1-hour
TTL cache. The human-readable `CACHE_VERSION` is kept alongside for log/debug legibility.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

---

## DEC-2 — getAllDocuments*/getDocumentMeta: mark in place, do not move

**Question**: Deep dive C6 says these are "script-only; move or mark". Move to a
script-support module, or mark with a consumer comment?

**Why it matters**: verification **falsified the script-only claim**: the shipped
migration `migrations/1766103664104_add-title-to-documents.js` requires
`server/postgres-persistence.js` and calls `getDocumentMeta` (line 80). Migrations
must keep working on fresh databases; moving the function breaks a committed migration.
`getAllDocumentsWithMeta` is also used by the integration-test harness
(`__tests__/integration/collaboration.test.js`).

**Decision**: **mark, don't move** (FR-007): a comment naming the consumers
(backfill script, title migration, test harness) so no future cleanup deletes them as
dead.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

---

## DEC-3 — Prop-drill collapse mechanism: context by default, plan may choose merge

**Question**: Deep dive C11 offers "merge chrome into the list or add a
`VersionHistoryContext`".

**Why it matters**: `VersionHistoryPanel` declares ~21 props and forwards most
unchanged; both fixes satisfy the requirement but differ in component-boundary shape.

**Decision**: spec requires the outcome (no pass-through-only forwarding, duplicated
empty-state JSX and unreachable loading branch removed, rendered output unchanged) and
defaults the mechanism to a **`VersionHistoryContext`** — it preserves the existing
component boundaries, which minimizes behavior-change risk and 041 rebase friction.
The plan phase MAY choose the merge instead if it is demonstrably simpler after 041
lands; either satisfies FR-012.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

---

## DEC-4 — legacy.js baselineClock branch: delete, do not wire up

**Question**: Deep dive C5 says "delete the production-dead `baselineClock` branch —
or wire it up deliberately".

**Why it matters**: wiring it up changes undo behavior for legacy-range derivation.

**Decision**: **delete** (FR-006). This feature's hard constraint is zero behavior
change; wiring up a dead branch is 041/product territory, not simplification. If a
future feature wants baseline-aware legacy ranges, the branch is one revert away in
git history.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

---

## DEC-5 — isMeaningful consolidation: conditional on 041, ownership stays with 041

**Question**: Deep dive C15 notes a shared `isMeaningful(u)` helper "fixes A2 as a
side effect", but A2 (drill-down meaningful filter) is assigned to 041.

**Why it matters**: both features would otherwise race to the same fix; 042's
constraint is zero behavior change, so 042 must not be the change that alters
drill-down filtering.

**Decision**: 041 owns the A2 behavioral fix. 042 consolidates the helper **only if
041 has not already introduced one**, and only as a pure refactor of whatever
predicate exists post-041 (FR-015, FR-017 rebase re-verification).

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

---

## DEC-6 — Scope exclusion: attribution-bug.test.js placeholders (deep-dive C7)

**Question**: C7 ("replace `attribution-bug.test.js` placeholder blocks with the real
test, or delete") sits in the deep dive's deletion list — include it here?

**Decision**: **excluded**. The real replacement test is E1 (end-to-end WS
attribution), which belongs to the test-gap bundle; deleting the placeholder without
the real test would remove the only marker that the coverage gap exists. Recorded as a
non-goal in the spec.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

---

## DEC-7 — FR-002 deletes a module the design docs describe as live — ESCALATED, NOT RATIFIED

**Added at plan time (2026-08-02).**

**Question**: FR-002 deletes `server/redis-persistence.js`. Two `design/` exports describe
that module as live infrastructure. Constitution Principle VI makes `design/` ground truth
and forbids hand-editing exports. What happens?

**The two exposures** (verified at plan time):

- `design/authentication-and-sharing.md:19` — *"Redis plays no role in auth — it caches Yjs
  docs and fans out updates/awareness across instances (`server/redis-persistence.js`,
  `server/redis-pubsub.js`), and is optional."* Names the file **by path**; deleting it
  leaves a dangling reference.
- `design/collaboration-core.md:23` — *"Named-version snapshots and a 24-hour Redis doc
  cache are the only materialized states."* That 24-hour cache (`DOC_TTL_SECONDS =
  24*60*60`, key prefix `yjs:doc:`) exists **only** in the module being deleted; grep found
  no other implementation.

**Why it matters**: both claims are **already false today** — nothing wires the module up,
so there is no 24-hour doc cache in the running system. This is pre-existing design drift
that FR-002 surfaces rather than causes. Constitution Principle I ("when analysis reveals
docs are already out of date, they MUST be corrected as part of the work that discovered
the drift") and Principle VI (amend the Squire source, re-export via `node design/sync.mjs`,
never hand-edit) both bind.

**Why this is NOT ratified by default**: every other decision in this ledger is a choice
this feature can execute. This one is not. The fix requires authoring an amendment in the
**source Squire documents**, which no pipeline agent can do — and the spec contains no FR
covering it, so the work is unscoped as well as unassignable.

**Default recommendation (needs an orchestrator/Sam action to enact)**: amend both Squire
design docs — drop the `server/redis-persistence.js` reference from the auth doc's Redis
sentence, and remove the 24-hour Redis doc cache from `collaboration-core`'s "materialized
states" claim — then `node design/sync.mjs`, and land that amendment **before or with**
042's merge. FR-002 is blocked until it does.

**Fallback if the amendment cannot be obtained**: descope FR-002 (keep
`server/redis-persistence.js` and its test). This costs 470 of roughly 865 available
deletion lines and makes **SC-002's ≥600-line target unreachable**, which would then also
need renegotiating (see contract C11).

**Status**: ⚠️ **OPEN — blocks FR-002.** Surfaced as the analyze gate's stop-the-line
finding.

---

## DEC-8 — FR-014: fold the fingerprint into the exported CACHE_VERSION

**Added at plan time (2026-08-02).**

**Question**: DEC-1 chose a source fingerprint in the cache-key namespace. *Where*
mechanically does it go — appended at the key-build site, or folded into the exported
`CACHE_VERSION` constant?

**Why it matters**: `server/__tests__/diff-service.test.js:712` pins the cache key as
`` `diff${CACHE_VERSION}:test-doc:-1:0` ``, interpolating the module's **exported**
`CACHE_VERSION`. Appending the fingerprint separately at the key-build site
(`diff-service.js:58`) would break that assertion and force a test edit — which FR-001 and
SC-001 forbid, since that test's subject is not deleted code.

**Decision**: make the exported `CACHE_VERSION` the composite itself
(`` `${humanVersion}.${sourceFingerprint}` ``, e.g. `v10.a1b2c3d4`) and leave the key
template at `:58` untouched. The pin test then passes **unmodified**, the human-readable
`v10` prefix stays legible for logs per DEC-1, and FR-014's semantics are unchanged.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

---

## DEC-9 — FR-010 moves the restore surgery without fixing its shape

**Added at plan time (2026-08-02).**

**Question**: FR-010 says the extracted `cloneXmlElement`/replace-delta code lands in
`server/yjs-utils.js` "where the viewer-deletion bug class is guarded". Verification
**falsified the premise**: `server/yjs-utils.js` (79 lines, exports `extractXml` and
`extractText`) contains no such guard, and no file in `server/`, `shared/`, or `client/src`
contains one. The nearest prior art is a comment at `server/markdown-import.js:328-331`
asserting "never recreate the fragment or doc" — above code that is itself a
delete-all+reinsert. Meanwhile the code being moved (`version-history.js:653-681`) *is* a
delete-all+reinsert, which sits in tension with Constitution Principle IV.

**Decision**: move it **unchanged**. `yjs-utils.js` is the right home for generic Yjs
surgery, but this feature adds no guard: doing so would be a behavior change forbidden by
FR-001, and the y-tiptap viewer-deletion bug class deserves its own feature with its own
tests (already tracked separately as the proposed 021 work).

The Principle IV tension is recorded in the plan's Constitution Check and Complexity
Tracking so that relocating the code does not launder it into "already reviewed".

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

---

## DEC-10 — FR-015 date consolidation is a collision resolution, not a merge

**Added at plan time (2026-08-02).**

**Question**: FR-015 requires date-formatter consolidation "without changing any rendered
string". Verification found the three implementations produce three **different** strings:

| Source | Output |
|---|---|
| `client/src/utils/datetime.js` `formatDateTime` | `Jun 20, 2026 at 8:16 AM` |
| `HierarchicalVersionList.jsx` local | `Jan 5, 4:30 PM` (no year, different join, explicit `hour12`) |
| `AdminPage.jsx` local | `Jun 20, 2026, 8:16 AM` (plus a `'Never'` null-guard) |

They are not substitutable. A literal "consolidation" would change rendered output in the
version-history panel and three admin tables.

**Decision**: treat this as the **name-collision resolution** the deep dive actually
described. Move each variant into `client/src/utils/datetime.js` under a distinct,
descriptive name and re-point its call sites; the `'Never'` null-guard travels with its
function as behavior. Net effect: one module owns date formatting, three names instead of
one colliding name, and **zero** rendered strings change. `formatVersionTimestamp` (a
fourth, already-shared variant) is untouched.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

**RESOLVED by the orchestrator (2026-08-02, option 1)**: both Squire source docs amended
same-day — authentication-and-sharing now reads "Redis is pub/sub fan-out only" with a
dated amendment note, and collaboration-core's materialized-states sentence now records
that the 24-hour doc cache was never wired up (and that named versions are pure
clock-range labels per 023, fixing a second stale claim in the same sentence found during
the amendment). Re-exported via `node design/sync.mjs` and committed alongside these plan
artifacts. FR-002 (delete the module + its test) and SC-002 stand unchanged. Gate cleared.

## DEC-11 — the nine [Restore] console.log lines (analyze finding M9) — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)

**Question**: `server/version-history.js`'s restore path carries nine `console.log('[Restore] …')`
diagnostic lines that no FR scopes; analyze flagged that removing them needed a decision.

**Decision**: remove them under FR-003's diagnostic-cleanup umbrella. FR-001 explicitly
exempts removed diagnostics/logging from the zero-behavior-change bar, and these are the
same class of leftover investigation logging as the ROOT CAUSE block FR-003 removes.
Error-path logging (console.error / notifier pages) stays untouched.

---

## DEC-12 — FR-017 rebase re-verification against post-041 `main` (544573c0)

**Added at implement time (2026-08-02).** Every claim in `research.md` R1-R17 was
re-greped against post-041 `main` before anything was touched. Outcomes:

**Claims that HELD unchanged** (proceed as written):

- **R1 / FR-002** — `server/redis-persistence.js` (142 lines) and its test (328 lines);
  the test is still the module's only `require` site. **DEC-7 gate: CLEARED** — `design/`
  no longer references `redis-persistence` anywhere, and `design/collaboration-core.md:23`
  now reads "the once-planned 24-hour Redis doc cache was never wired into any load path
  (dormant module removed, feature 042, amended 2026-08-02)". T011 proceeds.
- **R2 / FR-003** — the ROOT CAUSE block is intact (now `server/index.js:2214-2246`),
  8 `[RedisPubSub:ROOT_CAUSE]` lines, sibling `onAwareness` handler at `:2202`.
- **R5 / FR-006** — no external importer for `claimUndo`, `claimRedo`,
  `insertLegacyUndone`, `EDIT_ORIGIN`, `HISTORY_ORIGIN`, `LEGACY_GAP_MS`. The
  `baselineClock` branch survives at `legacy.js:97/108/118-119`, still with no production
  caller. `LEGACY_FRESHNESS_MS` and `_isIdentityRow` still have live test importers.
- **R6 / FR-007** — `getDiff` still has zero callers (`postgres-persistence.js:497`), and
  the doc comment naming it is at `:449`.
- **R4 / FR-005** — every `version-*` flat-list class family still matches **zero** JSX.
  (The only near-hits, `version-authors` and `version-menu`, are the `hierarchy-`-prefixed
  classes.) In `HierarchicalVersionList.css`, `.hierarchy-version-date`,
  `.hierarchy-version-edits`, `.hierarchy-combined*` and `.hierarchy-breadcrumb*` remain
  unreferenced.

**Claims that CHANGED** (tasks adapted or dropped):

- **DEC-5 / T046 — DROPPED.** 041 **did** introduce the shared helper:
  `isMeaningful(update)` at `server/version-history.js:204`, exported at `:1128`, already
  used at all five predicate sites (`:248`, `:558`, `:701`, `:1009`). FR-015's
  meaningfulness clause is therefore satisfied by 041 and is dropped from 042 per DEC-5.
- **FR-004's `refresh` alias — DROPPED from the deletion set.** Pre-041 its only consumer
  was one test (`useVersionHistory.test.js:481`). 041 made it the live test API for its own
  behaviour: it is now called at `:567`, `:591`, `:691`, `:716`, `:744`, `:762`, inside
  describes whose subject is 041's cache-invalidation and selection-reconciliation work,
  **not** `refresh` itself. Deleting it would force edits to tests outside the permitted
  list — which FR-001 forbids — so `refresh` stays. The rest of FR-004 is unaffected.
- **FR-005 CSS line anchors moved.** 041 grew the loading/error/empty group and added the
  live `.version-history-retry-btn`; `VersionHistoryPanel.css` is now 532 lines. Dead
  ranges re-derived by content, not by number. `.version-history-error` (`:170`) and
  `.version-history-retry-btn` (`:174-188`) are both **live** and kept.
- **FR-010's extraction target was rewritten by 041.** `restoreVersion` no longer builds a
  replace-delta inline: 041 introduced `applyRestoreTo(doc)` (`:832-859`), a fragment
  replacement run either on the live doc inside a transaction or on a temp doc. The
  extraction therefore takes `cloneXmlElement` (`:800-826`) **and** the delete-all+reinsert
  body of `applyRestoreTo`, leaving 041's live/durable path selection in place. Behaviour
  unchanged per DEC-9.
- **FR-015's `includeData` second call site moved.** `getUpdatesForVersion` is now at
  `:1000` (041 added the meaningful filter and the row-count fix) and `getContentAtClock`'s
  single-row re-fetch at `:1105`. Both still discard `updateData`; both still opt out.
- **DEC-11 count confirmed at nine.** `[Restore]` `console.log` lines are at `:771`,
  `:775`, `:793`, `:836`, `:852`, `:858`, `:908`, `:921`, `:927`. The `console.warn` at
  `:788` and the two `console.error` at `:868`/`:963` are error-path logging and stay.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

---

## DEC-13 — FR-014 (US4) is unimplementable under FR-001 — ESCALATED, NOT RATIFIED, DESCOPED

**Added at implement time (2026-08-02).**

**Question**: DEC-8 established that FR-014's source fingerprint could be folded into the
exported `CACHE_VERSION` so that `server/__tests__/diff-service.test.js:712`'s cache-key
assertion passes unmodified. Implementation found that assertion is **not the only pin**.

**What the survey missed.** `CACHE_VERSION` and the literal cache key are pinned in
**five** places across two pre-existing test files, three of which no composite value can
satisfy:

| Site | Assertion | Survives a composite? |
|---|---|---|
| `diff-service.test.js:712` | `` `diff${CACHE_VERSION}:test-doc:-1:0` `` | yes (interpolated) |
| `diff-service.test.js:794` | `` `diff${CACHE_VERSION}:${docGuid}:${prev}:${curr}` `` | yes (interpolated) |
| `diff-service.test.js:795` (CW-T6) | `key.startsWith('diffv10:')` | only if the separator is `:` |
| `diff-service.test.js:993` (CW-T6) | `expect(CACHE_VERSION).toBe('v10')` | **no** |
| `diff-service.test.js:997` (CW-T6) | `get` called with the literal `'diffv10:doc-ns:1:2'` | **no** |
| `markdown-strict-characterization.test.js:78` | `expect(CACHE_VERSION).toBe('v10')` | **no** |

Feature 039 deliberately froze both the constant and the exact key string. FR-014 requires
that exact string to change whenever pipeline source changes (SC-006). The two requirements
are in direct contradiction: **any** implementation of FR-014 forces edits to at least three
assertions in two test files whose subject is live code, not deleted code — which FR-001
and SC-001 forbid, and which fall outside tasks.md's exhaustive permitted-edit list.

Alternatives considered and rejected:

- **Fingerprint inside the cached payload** instead of the key (validate on read, treat a
  mismatch as a miss). Leaves `CACHE_VERSION` at `'v10'` and every pin intact, but the
  pre-existing cache-hit tests seed payloads with no fingerprint field, so the guard would
  have to treat "absent" as "accept" — which serves exactly the stale-shaped entries FR-014
  exists to prevent, for the duration of a TTL after every rollout. Achieving the
  requirement's letter while defeating its purpose is worse than not doing it.
- **`CACHE_VERSION = 'v10:fp<hash>'`** (separator `:` instead of `.`). Satisfies the two
  interpolated pins and CW-T6's `startsWith`, but still fails the two hard equalities.

**Decision**: **FR-014 / US4 (T025-T027) is DESCOPED from this feature** and reverted.
The zero-behavior-change bar (FR-001) is this feature's hard constraint and outranks a P3
requirement; implementing FR-014 would have been the one change in 042 that alters an
observable value, and it would have done so by rewriting pins another feature set
deliberately. `server/diff-service.js` is unchanged from post-041 `main`.

**Consequence**: SC-006 is unmet. SC-002 is unaffected (US4 only added lines). The manual
cache-bump hazard the deep dive identified (three bumps in three weeks) **remains open**.

**What enacting it would take** (an orchestrator/Sam decision, not a default this agent can
take): ratify that the diff cache namespace may change — accepting the one-time
invalidation, which is already an explicit spec Assumption — and authorise updating the
three 039-era assertions (`diff-service.test.js:993`, `:997`,
`markdown-strict-characterization.test.js:78`) to assert the *human* half of the composite
rather than the whole constant. That is a small, well-understood change; it is simply not
one FR-001 permits this feature to make on its own authority.

**Status**: ⚠️ **OPEN — FR-014 descoped, SC-006 unmet.**
