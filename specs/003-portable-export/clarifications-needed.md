# Clarifications Ledger — 003-portable-export

Per Constitution VI, undecided product questions get the best default, recorded here so nothing
is decided silently. All entries below are **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**
unless later overridden; overrides should update the spec and, where the design doc is affected,
flow through the source Squire document + `design/sync.mjs`.

---

## RD-1 — Portable flavor default on the REST export route

**Status**: OVERRULED by Sam, 2026-07-13 (decision walkthrough D-3) — was RATIFIED-BY-DEFAULT

> **OVERRULED by Sam, 2026-07-13 (decision walkthrough D-3):** portable is now the DEFAULT flavor on the REST export route for every format; `flavor=squire` is the explicit opt-in. The serializer function default (`toMarkdown()` = squire) is unchanged — it remains the internal canonical form for diffs and sync canonicalization. Implemented same day in server/api/docs-export.js with route tests updated. The "Default + rationale" below records the original (now superseded) decision.

**Question** (design doc "Open questions" #2): Should `flavor=portable` be the default for
`GET /api/docs/:docId/export` (a breaking change for existing consumers) or opt-in?

**Why it matters**: The existing route has live consumers (editor Export as Markdown download path,
`design/sync.mjs`, any `sk_sqd_`-token scripts). Changing the default silently changes their output bytes.

**Default + rationale**: **Opt-in.** `flavor=squire` remains the default; `flavor=portable` is an explicit
query option. This follows the design doc's own recommendation ("opt-in now, default in a versioned v2
route") and Constitution III (don't break the trunk for existing consumers without cause). A future v2
route may flip the default; that route is out of scope for M3. Note: the new `format=bundle` surface is
exempt — see RD-3.

---

## RD-2 — Highlight degradation in portable flavor

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13); scope narrowed by Sam, 2026-07-13 (walkthrough D-4)

> **Sam (2026-07-13, walkthrough D-4):** highlight is deprecated from the editor UI entirely (affordance
> removed, schema retained for legacy); the bold degradation now applies only to legacy content. Users can
> no longer create new highlight marks; the degradation rule below is unchanged and continues to apply to
> highlight marks in pre-existing documents.

**Question** (design doc "Open questions" #3): In portable flavor, should highlight degrade to
`==text==` (GFM-adjacent) or to bold (`**text**`)?

**Why it matters**: The whole point of portable flavor is clean GitHub rendering; the wrong choice
either shows literal `==` clutter or loses the "this was emphasized" signal.

**Default + rationale**: **Bold (`**text**`).** GitHub does not render `==text==` — it would appear as
literal punctuation, which is exactly the raw-HTML-tag problem portable flavor exists to fix. Bold is
lossy-but-visible: the reader still perceives emphasis, and the loss is declared in the frontmatter
`lossy` list (`highlight`), so sync tooling knows the file is not a faithful source for that mark.
Encoded as a degradation rule in the format registry per Constitution IV.

---

## RD-3 — Defaults for the new `format=bundle` surface

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)

**Question**: What flavor/frontmatter defaults should `format=bundle` use? (Not addressed by the
design doc; it only fixes the markdown route's default via open question #2.)

**Why it matters**: A bundle whose markdown still contains raw HTML marks and no images map defeats
its purpose, but defaults must be chosen once — changing them later is a breaking change.

**Default + rationale**: **`flavor=portable` and `frontmatter=true` by default, both overridable.**
The bundle is a brand-new surface with zero existing consumers, so RD-1's back-compat argument does not
apply; it exists precisely for repo portability, and the images map (required for round-trip resolution)
lives in the frontmatter, so frontmatter-off bundles would be self-defeating. `format=markdown` defaults
are unchanged.

---

## RD-4 — Foreign frontmatter preserve/re-emit contract

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)

**Question**: Design §2.3 says non-Squire frontmatter is "preserved as-is at the top of the doc body"
but does not say how a later export reconstitutes it. Two frontmatter fences in one file don't work —
most tools read only the first block. What is the exact contract?

**Why it matters**: Spec-kit and static-site tooling own their own keys; a pull that re-exports the doc
must not destroy them, or every sync cycle strips the repo file's tooling metadata.

**Default + rationale**: **Single merged block.** On parse: the frontmatter block (recognized only at
line 1, with a valid closing fence and a YAML mapping) has its `squire:` top-level key stripped and
surfaced as metadata; the remaining keys are preserved verbatim (bytes and order). On export with
`frontmatter=true`: one frontmatter block is emitted containing the preserved foreign keys verbatim
first, then the regenerated `squire:` key. This keeps exactly one fence, keeps other tools' parsers
working, and makes foreign keys byte-stable across import→export (spec SC-005). How the preserved
foreign block is represented inside the document between parse and export is an implementation choice
for the plan phase — the observable contract is byte-stable re-emission.

---

## RD-5 — Bundle asset filename scheme

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)

**Question**: What are asset files named inside `assets/<docSlug>/`? Original upload filenames are
human-friendly but collide and can change; anything non-deterministic churns git diffs on every pull.

**Why it matters**: Repo files are re-exported on every pull sync; unstable asset names would produce
noisy diffs and broken references, and colliding names would silently overwrite bytes.

**Default + rationale**: **`<imageId>.<ext>`** — the image's id plus the extension derived from its
stored content type. Deterministic across exports of an unchanged document, collision-free by
construction (ids are unique per image), and trivially reversible against the frontmatter `images` map.
Readability loses to diff stability for the sync use case.

---

## RD-6 — `lossy` list semantics

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)

**Question**: Should the frontmatter `lossy` list enumerate every mark that *could* degrade in portable
flavor, or only the marks *actually degraded in this document*?

**Why it matters**: Feature 004 uses `lossy` to decide whether a file is a faithful write-back source
for a mark; over-reporting would make sync needlessly conservative for documents that never used the mark.

**Default + rationale**: **Actual degradations only**, computed per export; the key is omitted entirely
when nothing degraded. Matches the design's example (`lossy: [textStyle]` — a specific document's actual
loss) and gives sync tools a precise signal. Consequence, also spec'd: `flavor=portable` without
frontmatter degrades silently (there is no annotation channel) — documented, not an error.

---

## RD-7 — Hard-break emission form

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)

**Question**: The design mandates the trailing-backslash form for the serializer; is it the same in both
flavors, and what input forms must the parser accept in M3?

**Why it matters**: Two-space breaks are invisible in editors and get stripped by formatters; the choice
affects round-trip byte-stability (M4's invariant).

**Default + rationale**: **Trailing backslash in both flavors** (GitHub renders it; it is visible and
formatter-safe). Parser accepts the backslash form and `<br>` (the forms named by the design for M3);
broader tolerance (e.g. two-space breaks) belongs to feature 001's general-input grammar, not here.
Backslash is the canonical re-export form.

---

## RD-8 — Task checkbox canonical form

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)

**Question**: Which checkbox spellings parse, and which is emitted?

**Why it matters**: GFM tooling in the wild emits both `[x]` and `[X]`; canonicalization affects the
byte-stability round-trip invariant.

**Default + rationale**: Parse `[ ]`, `[x]`, `[X]` (GFM behavior); always emit lowercase `[x]`.
One canonical output form keeps `import(export(doc))` byte-stable and matches the design's examples.

---

## RD-9 — Frontmatter size cap (plan phase)

**Status**: RATIFIED-BY-DEFAULT (plan phase, 2026-07-13)

**Question**: FR-016 requires a size cap on parsed frontmatter blocks; the value was deferred to
plan phase (see "Flagged for awareness" below).

**Why it matters**: Frontmatter is untrusted input; the cap bounds YAML-parse work on hostile input
and defines when a `---`-fenced block stops being metadata and becomes content.

**Default + rationale**: **64 KB**, measured from opening to closing fence inclusive; an oversized
block is treated as ordinary document content (never an error, never truncated). Realistic
frontmatter (squire block + foreign tooling keys + a large images map) stays well under 8 KB; 64 KB
gives ample headroom (even a ~500-entry images map fits) while keeping hostile-input parse cost
trivial and staying below request-body limits import surfaces will use. See research.md R8.

---

## RD-10 — Subscript/superscript are NOT degraded in portable flavor

**Status**: RATIFIED-BY-DEFAULT (plan phase, 2026-07-13)

**Question**: FR-010 names underline, highlight, and styled spans as portable-flavor degradations.
`subscript`/`superscript` are also HTML-tag marks (`<sub>`/`<sup>`) — should they degrade too?

**Why it matters**: Determines whether portable exports of scientific/footnote-style text show HTML
tags on GitHub, and whether `sub`/`superscript` can ever appear in the `lossy` list.

**Default + rationale**: **No degradation** — `<sub>`/`<sup>` are emitted unchanged in both flavors
and never appear in `lossy`. GitHub's markdown sanitizer allowlists these tags and renders them
correctly, so they are already portable; degrading them (to what — `~x~`/`^x^` are not GFM) would
lose meaning for zero rendering benefit. This matches the design doc's degradation list (§2.2 names
only underline, highlight, color/font spans) and SC-002's scope ("every degradable mark"). If GitHub
ever changes its allowlist, a registry `portable` declaration can be added with automatic test
coverage (SC-006).

---

## Flagged for awareness (no decision required in M3)

- **Design doc drift**: design §2.2 says portable is the "default for repo sync" while open question #2
  recommends opt-in on the REST route. RD-1/RD-3 reconcile these (opt-in on the existing route, default
  on the new bundle surface, which is the repo-sync vehicle). If M4's sync tooling pulls via
  `format=markdown` instead of `format=bundle`, it should pass `flavor=portable&frontmatter=true`
  explicitly — worth restating in 004's spec.
- **Frontmatter size cap value**: FR-016 requires a cap; the specific number is a plan-phase choice
  (suggest matching existing request-body limits; oversized blocks degrade to content, never error).
