# Clarifications Ledger: 004-two-way-sync

Decisions made without user interaction, per pipeline rules. Each is recorded as
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)** and can be overturned by
amending the design doc (Constitution VI) and this spec together.

---

## D1 — Baseline retention window and failure mode (design "Open questions" #1)

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: What retention window applies to reconstructible baseline clocks (= maximum
  allowed staleness of a repo file), and what happens when a push's baseline falls outside it —
  reject with re-pull instructions, or degrade to whole-doc replace?
- **Why it matters**: Baseline reconstruction at the frontmatter clock is a hard prerequisite
  of the whole protocol (design §2.4.1(d)). The failure mode decides whether a stale file can
  ever silently clobber a live document.
- **Default chosen**: **v1 retention window = unlimited.** Per `design/collaboration-core.md`
  there is currently no compaction or squashing — the full update log is retained and every
  historical clock is reconstructible today, so no new retention machinery is needed or built.
  The failure mode is specified anyway as a forward guard (FR-015, User Story 5): a baseline
  the server cannot reconstruct (or an invalid one — negative, malformed, beyond the current
  clock) is **rejected with a machine-readable error and re-pull guidance**, leaving the
  document untouched. The server never degrades to whole-document replace (002's non-sync
  `mode=replace` remains the explicit opt-in for clobber semantics). Any future
  compaction/retention feature inherits this error contract as its constraint.
- **Rationale**: Rejection is the design doc's own recommendation; silent whole-doc replace
  would violate Constitution IV (destroys CRDT identity, attribution, and concurrent edits)
  exactly in the case where the file is most out of date. Unlimited retention is not a new
  promise — it is the current, tested behavior of the persistence layer.

## D2 — Per-document token scoping for push (design "Open questions" #4)

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: Does `documents:write` on `sk_sqd_` tokens need per-document scoping before
  shipping push, or is account-level scope plus document ACLs enough for v1?
- **Why it matters**: A CI-resident token is a standing credential; its blast radius on
  compromise is a security question (Constitution V).
- **Default chosen**: **Account-level `documents:write` plus per-document ACL enforcement is
  sufficient for v1; no per-document token scoping.** Every push re-checks the token owner's
  write role on the target document (FR-003), so a token can never reach documents its human
  couldn't already edit. Tokens remain scoped and expiring per the existing credential system
  (and `create_access_token` already supports minting short-lived, scope-capped tokens for CI).
- **Rationale**: Matches the existing MCP/REST authorization model (scope gate + per-document
  re-check inside every tool/route); per-document scoping is additive later without any
  protocol change, and building it now is ceremony without a concrete failure it prevents
  (Constitution III). Revisit before M5 ships a GitHub Action that encourages long-lived
  repo-secret tokens.

## D3 — Baseline clock source precedence

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: The design says the push carries the baseline clock via "frontmatter or param"
  — which wins when both are present, and what happens when neither is?
- **Default chosen**: Frontmatter `squire.clock` is the canonical carrier; an explicit request
  parameter, when supplied, **overrides** frontmatter (supports tooling that strips or manages
  frontmatter itself). Neither present → the sync push is rejected (User Story 5, scenario 3).
- **Rationale**: The file being self-describing is the frontmatter contract's purpose (003);
  the override keeps the protocol API-first for third-party clients. Guessing a baseline (e.g.
  defaulting to current clock) would turn stale pushes into silent overwrites.

## D4 — Sync mode naming on the 002 route

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: How is the sync push addressed on the PUT import route?
- **Default chosen**: `mode=sync` alongside 002's `mode=append|replace`. One route, one new
  mode value.
- **Rationale**: The design places the push protocol on the import endpoint ("this is the
  write half of the sync protocol in Part 2.4"); a separate route would duplicate auth,
  limits, and image policy for no benefit.

## D5 — Idempotent retries (deterministic replay)

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: What happens when the same push is delivered twice (network retry, CI re-run
  of an unchanged file against an unchanged baseline)?
- **Default chosen**: Replay is required to be deterministic over (document, baseline clock,
  canonical pushed content) — FR-011 — so an identical retry re-produces the identical update
  and CRDT application deduplicates it: no doubled content, no second version entry's worth of
  changes. (A re-push of an unchanged file whose local frontmatter was already rewritten to the
  new clock is simply a no-op per FR-009.)
- **Rationale**: The design offers no retry path and no compare-and-set; determinism is the
  only way "push is order-independent and safe" extends to at-least-once delivery, which CI
  and flaky networks make inevitable. Cost is a constraint on synthetic-client-identity
  derivation, not a new mechanism.

## D6 — On-behalf-of metadata shape and handling

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: What exactly does `onBehalfOf` carry and how is it treated?
- **Default chosen**: Optional fields: author name, author email, commit identifier (sha),
  and optionally a commit URL. Recorded with the push's version entry and surfaced in version
  history **as plain text only** — length-capped, never rendered as markup or links derived
  from untrusted input beyond the URL field being displayed as text (FR-013). It supplements,
  never replaces, the token identity: authorization and the authoritative author remain the
  credential's user.
- **Rationale**: Matches the design's "git commit author/sha" examples; treating it as
  untrusted display metadata satisfies Constitution V without inventing a second identity
  system.

## D7 — No-op push response semantics

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: What does a formatting-only / unchanged push return?
- **Default chosen**: Success (not an error), explicitly marked as a no-op, carrying the
  document's **current** clock and the canonical re-export — so the sync tool still refreshes
  the local file (picking up any doc-side edits since the baseline) even when it contributed
  nothing. No update stored, no version entry (FR-009).
- **Rationale**: The pull/push loop stays uniform for tooling ("always rewrite the local file
  from the receipt"), and treating no-ops as errors would make idempotent CI pipelines fail
  spuriously.

## Flagged (not resolved here) — for the design doc / later features

- **Design "Open questions" #2** (portable flavor as REST export default) and **#3**
  (highlight degradation choice) belong to feature 003's scope; this spec only assumes 003's
  contract, whatever those resolve to.
- **Retention policy design** (if compaction is ever introduced): D1 fixes the *contract*
  (reject + re-pull), not the window. When a compaction feature is designed, its spec must
  define the sync retention window and update `design/markdown-import-two-way-sync.md`
  §2.4.1(d) accordingly.
