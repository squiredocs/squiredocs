# Clarifications Ledger: 057-live-doc-consistency

Per Constitution VI, unanswered product decisions get the best default,
recorded here — work never blocks on the maintainer, and nothing is decided
silently. All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-08-11)** unless later overturned.

---

## RBD-057-1 — read_document one-source strategy: label-what-you-integrated, not a blocking fence

**Question**: The design amendment offers two acceptable shapes for the
one-source clock: "either fence the in-memory doc against the DB max clock
before serving, or label with the max contiguous clock actually integrated
plus an explicit staleness marker". Which one?

**Why it matters**: A blocking fence gives always-fresh reads at the cost of
read latency coupled to repair latency (a diverged pod would block or fail
reads until repaired). Labeling is non-blocking but can serve
honestly-stale content.

**Default chosen**: Label with the highest contiguous integrated clock and
attach the explicit staleness indicator when the same call's durable-clock
query exceeds it (FR-001/FR-002). A staleness-marked serve also triggers a
reconciliation pass so the next read converges. No blocking fence on the
read path.

**Rationale**: The read path is hot and already performs the durable-clock
query, so the marker is free; honesty-without-blocking matches the 021
posture for still-gapped reads ("served as-is; the next read heals") — now
with the heal made real by reconciliation instead of assumed. This is also
the same atomicity contract the export path uses (label exactly what was
built), adapted to a serve-from-memory path. A fence would couple agent read
latency to repair latency for a window reconciliation already bounds.

---

## RBD-057-2 — Periodic check cadence and cost bound

**Question**: The design mandates "a cheap periodic MAX(clock) check" but
names no cadence and no cost budget.

**Why it matters**: Too frequent burdens the hot collab server and the
database with per-pod polling; too infrequent stretches the divergence
window the check exists to bound.

**Default chosen**: One batched query per pod per period covering all
currently-bound documents (single round trip: newest clock per bound doc
GUID), compared against each doc's in-memory integrated clock; only
documents found behind perform a row fetch. Period: **30 seconds**,
env-tunable as a named constant. The no-divergence steady state is one cheap
query per pod per period, independent of document count and document size.

**Rationale**: 30s halves the current worst case (the ~60s eviction TTL that
is today's only healer) while keeping load negligible (2 queries/minute/pod).
Batched-per-pod keeps cost O(period), not O(docs × period). SC-002's "≤ 60
seconds worst case" gives headroom for one missed cycle. Tunable without
protocol impact.

---

## RBD-057-3 — Incomplete-load refusals: keep the retry defaults, count loudly, page quietly

**Question**: (a) Should the in-call gap-retry budget (COLLAB_READ_GAP_RETRIES,
default 2 retries / 400ms, not overridden in prod) be raised now that a
still-gapped bind refuses instead of serving? (b) Does a gap-typed refusal
page the exception notifier the way a load-error refusal does?

**Why it matters**: (a) A too-small budget turns routine mid-commit races
into refusal/retry churn; a too-large one stretches bind latency for every
racing bind. (b) 041's refusal pages because it means the database is
failing; a gap refusal usually means a benign race lost — paging on it is
noise, but never paging hides real damage.

**Default chosen**: (a) Keep the existing defaults unchanged; the client-side
retry (1013 + provider backoff) is the second budget and makes the combined
window generous. (b) Gap/short-typed refusals emit the refusal metric with a
distinct reason label (FR-004, FR-010) but do **not** page on first
occurrence; repeated refusals for the same document reuse the existing
per-document page throttle so a *persistent* incomplete load (RBD-057-4
territory) does page. Load-error refusals keep 041 behavior exactly.

**Rationale**: Post-023 serialization makes transient gaps short and rare;
two in-call retries plus client backoff-and-rebind should clear essentially
all of them. Separating reason labels keeps the DB-outage canary (041's
purpose) clean while making the new defect class visible. The per-document
throttle is already built and already the answer to "page on persistence,
not on blips".

---

## RBD-057-4 — Persistent-gap posture: fail closed and page (flagged as a design gap)

**Question**: The amendment says an incomplete load "refuses the bind
(clients retry)" — but it does not say what happens if the gap never heals
(a genuinely missing row: log damage, operator surgery). Refuse-forever makes
the document permanently unbindable; serve-anyway reintroduces the memoized
torn copy the amendment retires.

**Why it matters**: This is availability vs. honesty for a (hopefully
never-occurring) damaged log. Post-023 write serialization should make
permanent interior gaps impossible in an intact log, so any occurrence is
evidence of real damage.

**Default chosen**: Fail closed: keep refusing, and let the sustained
refusals page through the existing per-document throttle (RBD-057-3(b)) so a
human intervenes. No automatic serve-the-damage fallback in this feature.

**Rationale**: Matches the ratified 041 posture (RBD-041-1: a blank-doc lie
is worse than an outage-shaped "connecting") and the amendment's direction
(refusal over memoized distrust). An automatic fallback would need its own
ratified honesty contract (what do we tell clients we are serving?) — that
deserves a real decision, not a default. **Flagged as a design gap** for
Sam: the amendment should say what a permanently-incomplete log means for
bindability (this default stands until it does).

---

## RBD-057-5 — Readiness gate: count semantics and timeout behavior

**Question**: "Readiness waits for what it counted" — counted against what,
and what happens on timeout?

**Why it matters**: The count is fetched from the durable log while updates
integrate asynchronously; a wrong comparison basis re-creates the defect
(resolving before the counted state is present) or hangs (waiting for a
count that later edits made stale).

**Default chosen**: The gate resolves when the session doc's integrated
contiguous clock covers the update set counted at gate-arm time (i.e., the
doc has integrated at least everything the count described — later edits
arriving early can only over-satisfy, never starve, the condition). Counted
= 0 resolves immediately. The existing readiness timeout is kept with its
current duration and current on-timeout semantics — the change is only what
"ready" means, not how long we wait or what timeout yields.

**Rationale**: Comparing integrated state to an at-arm snapshot is the
minimal honest fix for Defect D and is monotone (cannot deadlock on
concurrent edits, which only add updates). Preserving timeout semantics
keeps SC-007 (no behavioral regression beyond the contract) checkable.

---

## RBD-057-6 — Staleness indicator shape

**Question**: How is staleness surfaced to `read_document` callers?

**Why it matters**: Agents parse read results programmatically; an
unstructured warning would be invisible to them, while a breaking result
shape would ripple through every caller.

**Default chosen**: Additive, machine-readable fields on the existing
response: the labeled (integrated) clock stays in the field callers use
today — it just becomes honest — plus, only when they differ, the newest
known durable clock and a stale flag, with a short human-readable note in
the rendered output. No fields change meaning or disappear; a current copy
carries no staleness fields.

**Rationale**: Backward compatible by construction (absent = current, which
is also today's implied claim), and the labeled clock remaining the
baseline-safe one means existing callers get safer without changing. Mirrors
how the export path surfaces lossiness: honest, additive, ignorable.

---

## Design gaps flagged for Sam (not blocking; defaults above stand meanwhile)

1. **Persistent-gap bindability** (RBD-057-4): the amendment's
   refuse-on-incomplete contract has no terminal state for a log that is
   permanently incomplete. Default: fail closed + throttled paging.
2. **Telemetry bullet**: the design amendment's ratified contract lists four
   bullets; the metrics requirement (FR-010) comes from the feature
   directive and the existing bind-refusal counter precedent rather than a
   fifth design bullet. If Sam wants the amendment to carry it, the Squire
   doc needs a one-line addition (per Constitution VI, the export is not
   hand-edited here).
3. **039 contract supersession** (FR-012): the read-completeness contract's
   "Non-consumers / self-heal on the next read" paragraph is now false for
   memoized readers; this feature annotates it, but the 039 spec family was
   otherwise left untouched — flagging in case Sam prefers a fuller sweep.
