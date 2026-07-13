# Clarifications Ledger — 001-general-markdown-parser

Decisions the design docs (`design/markdown-import-two-way-sync.md`, `design/document-model-format-pipeline.md`) do not settle, resolved with best defaults per Constitution Principle VI. Each entry is referenced from `spec.md` as CN-#.

---

## CN-1: Does the diff engine use strict or tolerant mode?

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: Design §1.1 says "Keep the function signature … so diff-service.js is untouched. Add a `strict` option: the diff engine **can** opt into today's exact-dialect behavior **if we want to be conservative** there." Which is it — does diff-service opt in, and is the default mode tolerant or strict?
- **Why it matters**: The diff engine parses *partial hunk fragments* from line-based diffing, not whole documents. Tolerant re-interpretation of fragments can change diff rendering (e.g. a hunk whose fragment ends in `---` would become a setext heading underline instead of a horizontal rule). This is the only production caller today; getting it wrong regresses a shipped user-visible feature.
- **Chosen default**: Tolerant is the parser's default mode; the diff engine explicitly opts into strict mode (a one-line call-site change — the design's "untouched" refers to signature/architecture, not to forbidding a one-line option). Rationale: the general parser exists for import consumers (002+), which all want tolerance, so tolerance is the right default; the diff engine's fragment-parsing use case is exactly the conservative case strict mode was invented for, and opting in costs nothing while eliminating all regression risk.

## CN-2: What exactly does "strict mode" mean?

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: Is strict mode (a) byte-identical preservation of today's parser behavior, or (b) "tolerant minus the risky extensions"?
- **Why it matters**: Determines the compatibility guarantee for the diff engine and whether cached diff documents (Redis, keyed by `CACHE_VERSION`) stay valid; also determines how strict mode is tested.
- **Chosen default**: (a) Byte-identical: for any input, strict-mode output equals the pre-feature parser's output. Rationale: it is the only definition that makes "existing diff tests pass unchanged" a sufficient proof and lets the Redis diff cache version stay untouched; a fuzzier definition would need its own grammar spec for no benefit.

## CN-3: Task-list degradation — is the checkbox marker text kept or stripped?

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: Design says task lists "degrade to bulletList" until feature 003 adds schema nodes, but not whether `- [x] Ship it` becomes a bullet item reading "Ship it" (marker stripped) or "[x] Ship it" (marker preserved).
- **Why it matters**: Stripping the marker silently destroys the checked/unchecked state — information the user authored that cannot be recovered, violating the spirit of the never-lose-content rule. Preserving it looks slightly raw in the editor until 003 ships.
- **Chosen default**: Preserve the literal marker (`[ ] ` / `[x] `) as leading item text (which is also today's de-facto behavior, since the current bullet regex already captures it). M1's added value is the explicit recognition seam + tests locking the degradation + the documented handoff so 003 flips the seam to emit real task nodes. Rationale: checked state is content, not syntax; cosmetic rawness is temporary (003 is already scheduled), data loss is permanent.

## CN-4: HTML entity coverage — full HTML5 named-entity table or a subset?

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: CommonMark requires recognizing all ~2,100 HTML5 named entities. Shipping the full table means embedding a sizable data blob in a zero-dependency shared module; a subset deviates from spec conformance.
- **Why it matters**: Affects bundle size of a client-shared module, the zero-dependency posture, and which CommonMark entity examples can be claimed as passing.
- **Chosen default**: Full support for numeric references (decimal and hex) plus a curated set of the commonly used named entities (at minimum: amp, lt, gt, quot, apos, nbsp, copy, reg, trade, mdash, ndash, hellip, laquo, raquo, ldquo, rdquo, lsquo, rsquo, times, deg, middot, bull, para, sect, plusmn, frac12, dagger, Dagger, permil, euro, pound, yen, cent, sup2, sup3, micro, and the arrows larr/rarr/uarr/darr/harr); unrecognized named entities are preserved as literal text (never dropped — satisfies never-lose-content). Rationale: numeric references give full expressive coverage for anything the named table would; the curated set covers what agents and humans actually type; the full table can be added later without breaking anything (unknown-entity behavior is lossless). Corresponding entity spec examples outside the subset go on the documented exclusion list (CN-7).

## CN-5: Bare-autolink scheme scope

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: Design says "autolinks (`<https://…>` and bare URLs)" without defining which bare forms qualify.
- **Why it matters**: Over-eager bare-URL detection creates false-positive links in prose (e.g. `node:fs`, `a.b`); under-scoped detection misses what agents emit constantly.
- **Chosen default**: CommonMark angle-bracket autolinks in full (absolute URI schemes and email → mailto), plus GFM-extension bare autolinks limited to `http://`, `https://`, and `www.`-prefixed domains — i.e., exactly the GFM autolink extension's www/url/email productions, minus bare email detection (kept out of v1 to avoid false positives on `@handle`-adjacent text; angle-bracket email autolinks still work). Rationale: matches what GitHub renders, which is the interoperability target for this whole design.

## CN-6: `<span style>` with unrecognized CSS properties

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: The whitelist admits `<span style>` "with the registry's style props". What happens to a span carrying unknown properties (`text-shadow: …`), or only unknown properties?
- **Why it matters**: Sits at the intersection of the whitelist rule ("everything else preserved as literal text") and usability (a span with `color` + one exotic prop should not degrade to raw HTML text).
- **Chosen default**: Parse the span if at least one registry-recognized property is present, applying recognized properties and dropping unrecognized ones (styling loss allowed; text preserved — same policy the existing CSS-to-attrs helper already implements by ignoring unknown props). A span with zero recognized properties is preserved as literal text, tags included, per the whitelist rule. Rationale: consistent with existing `cssToAttrs` behavior and with the degradation ladder (structure/styling may degrade, text may not).

## CN-7: CommonMark/GFM conformance measurement

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: Design mandates "an explicit supported grammar … and import the official CommonMark + GFM spec test fixtures for the constructs we do support," but not which examples count or what pass bar applies.
- **Why it matters**: Without a defined bar, "supports emphasis" is unfalsifiable; with a naive "all examples" bar, the feature inherits full-CommonMark scope through the back door (contradicting the design's explicit decision not to chase full conformance).
- **Chosen default**: For each supported construct (spec FR-003…FR-011), curate the relevant official spec examples into checked-in fixtures; target 100% pass of the curated set; any example in a covered area that is excluded MUST appear in an exclusion list with a one-line reason (e.g. "requires reference-link definitions — unsupported construct"). Expected structure is expressed against Squire's schema (the spec fixtures' HTML expectations are translated once, at curation time). Rationale: makes conformance falsifiable and reviewable while honoring the design's bounded-grammar decision.

## CN-8: GFM tables beyond the current dialect

**FLAGGED GAP + RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: The design's M1 priority list does not mention tables at all, yet GFM tables in the wild frequently omit leading/trailing pipes — which the current parser (line must start with `|`) will not recognize. Is table tolerance in M1 scope?
- **Why it matters**: Silently excluded common real-world input; but adding it is scope the design did not ask for.
- **Chosen default**: Out of M1 scope. The existing pipe-leading table dialect keeps working (with alignment-colon separators tolerated, as today); table rows without a leading pipe degrade to paragraphs preserving the text (never-lose-content holds). Flagged here as a design silence — if real-world corpus testing (SC-002) shows this biting, promote it via a design-doc amendment rather than ad-hoc scope creep.

## CN-9: Hard line breaks (backslash / two-space) — M1 or M3?

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-13)**

- **Question**: The design puts `<br>` → hardBreak in M1's whitelist item, but the sentence "Parser accepts backslash and `<br>` forms" lives in §2.2 (M3, alongside the hardBreak *serializer* fix). Which milestone owns parsing the backslash and two-trailing-space break forms?
- **Why it matters**: Splitting one tiny grammar rule across milestones creates an awkward seam; deferring it means M1's "tolerant CommonMark" drops a construct agents emit routinely.
- **Chosen default**: M1 parses all three hard-break forms (`<br>`, trailing backslash, two trailing spaces) into the schema's existing hardBreak node — the node already exists, so no schema work is needed; M3 keeps only the serializer-side fix (emitting hardBreak on export). Rationale: parsing is squarely "tolerant grammar" (M1's charter); only serialization belongs to M3's export-fidelity charter.

## CN-10: Documentation updates owed at ship time (not performed by this spec agent)

**FLAGGED GAP (process, not product)**

- **Question**: Who updates the now-stale current-state statements once M1 ships — `design/document-model-format-pipeline.md` (says the parser lives in `server/markdown-to-pm.js` and "parses only the dialect toMarkdown emits") and `README.md`?
- **Why it matters**: Constitution Principle I (docs reflect reality) and Principle VI (exported design docs must be amended in Squire and re-synced, never hand-edited). This spec agent is barred from editing README/design exports.
- **Disposition**: Deferred to the implementation/merge phase of the pipeline: amend the source Squire document for the format-pipeline doc, re-export via `design/sync.mjs`, and update `README.md` in the shipping commit. Recorded here so it cannot be forgotten; no product decision involved.

---

## Implementation findings (recorded during T009–T019, ledgered per no-silent-decisions)

### IF-1: CommonMark flanking vs the serializer's space-padded marks (tolerant ≠ strict edge)

- **Finding**: The strict parser matches emphasis with a non-flanking regex (`\*\*(.+?)\*\*`), so it accepts a mark applied to space-padded text, e.g. the serializer output `** x **` (a bold mark whose text has a leading/trailing space) parses as bold. The tolerant parser follows CommonMark left/right-flanking rules, under which `** x **` is **not** emphasis. So for the rare canonical input where a mark wraps text with a leading or trailing space, tolerant output diverges from strict.
- **Assessment**: Accepted, not a regression. (a) It is an inherent, intended consequence of adopting CommonMark flanking — the design's explicit choice. (b) The only production consumer today, the diff engine, uses **strict** mode and is unaffected. (c) Realistic serializer output applies marks to trimmed text, which round-trips identically in both modes (the full registry-driven round-trip suite passes in both modes). (d) For import surfaces (002+, tolerant), rejecting `** x **` as emphasis is the CommonMark-correct behavior anyway. No content is ever lost — the delimiters degrade to literal text.
- **Owed at merge**: none (behavioral, documented). If a future consumer needs Squire→tolerant round-trip of space-padded marks, revisit via a design amendment rather than weakening flanking.

### IF-2: Pipe-in-cell tables are a pre-existing lossy round-trip (kept byte-identical)

- **Finding**: A table cell containing a literal `|` is serialized as `\|`, but the current parser splits rows on **every** `|` (the `\|` is never reassembled). This pre-existing quirk is faithfully reproduced by the tolerant table path, so strict and tolerant remain byte-identical on canonical table input (verified). Not fixed in M1 because a fix would change the canonical parse (US3 AS-3) and CN-8 scopes table work out of M1.
- **Owed at merge**: none. Candidate for a future GFM-tables design amendment (CN-8 already flags table tolerance as a design silence).
