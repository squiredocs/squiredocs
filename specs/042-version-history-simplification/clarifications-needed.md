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
