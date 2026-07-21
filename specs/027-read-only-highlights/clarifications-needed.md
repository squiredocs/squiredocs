# Clarifications Ledger: 027-read-only-highlights

Per constitution Principle VI, unanswered product decisions get the best default,
recorded here as RATIFIED-BY-DEFAULT. Sam pre-authorized default ratification for
this feature (2026-07-21). Design ground truth: design/agent-surface-mcp.md,
"Amendment (Sam, 2026-07-21) — reads never write" (commit 6bacaf7).

---

## D-1 — Mixed-version deploy window: no compatibility shim for old position shapes

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-21)

**Question**: Changing anchor construction for text-less blocks alters the serialized
RelativePosition JSON shape those blocks emit. During a rolling deploy, a viewer may
receive old-shape positions (anchored to a placeholder text node an old server just
created) and new-shape positions (element-boundary-anchored) in the same session.
Should we ship a compatibility shim so both shapes always render?

**Default chosen**: No shim. Old shapes only ever occur live — presence positions
travel over ephemeral awareness and are never persisted — so the exposure is a
transient mixed-session window during deploy. The client resolver already returns
null for unresolvable positions and the viewer skips rendering them, so the worst
case is a briefly skipped highlight step. Transient and acceptable.

**Rejected alternative**: dual-shape emission or a client-side normalizer — adds
permanent complexity (and a client change, violating the no-client-changes scope)
to cover a one-deploy transient.

---

## D-2 — Highlight rendering for text-less blocks: element-boundary selection, not omission

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-21)

**Question**: When a read sweep or node selection covers a text-less block, should the
block get a boundary-anchored highlight, or may it be skipped (simplest zero-write fix)?

**Default chosen**: Boundary-anchored highlight, mandatory (spec FR-003/FR-004,
SC-003). The design amendment states positions "anchor to the element boundary
itself" — omission would be a silent fidelity regression of the presence feature and
contradicts ground truth. The acceptance test asserts positions for text-less blocks
resolve non-null on a live replica under the client's resolution semantics.

**Rejected alternative**: skip text-less blocks in sweeps — passes the zero-writes
test while degrading the product; explicitly blocked by FR-004.

---

## D-3 — Invariant breadth: fix the shared helpers for all paths, including mutation sweeps

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-21)

**Question**: Scope the fix to the read path only (where the attribution damage is
user-visible), or make the shared position helpers pure on every path including
mutation cursor sweeps?

**Default chosen**: All paths (spec FR-001/FR-006, User Story 3). The design
amendment is explicit: "the invariant covers every presence-effect position
computation (read highlights, temporary selections, mutation cursor sweeps): the
position math itself never writes." Mutation edits themselves still write and are
attributed exactly as before — only position computation becomes side-effect-free.

**Rejected alternative**: read-path-only fix with a write-allowed flag for mutation
sweeps — leaves the invariant violable and adds a mode switch to helpers that
should simply be pure.

---

## D-4 — Offset past the end of a text-less element: clamp to boundary, don't throw

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-21)

**Question**: Today, an offset beyond a block's text clamps to the end of the last
text run; when there is no text run the code "fixed" it by creating one. With
creation forbidden, should an offset into a text-less element throw or clamp?

**Default chosen**: Clamp to the element boundary — consistent with the existing
lenient clamp-to-end behavior for text-bearing blocks, and consistent with FR-009's
fail-observational stance (a presence effect must never abort a read, and must never
write). Position requests with any offset into a text-less element yield the
boundary anchor.

**Rejected alternative**: throwing on nonzero offsets into text-less elements —
turns a cosmetic presence computation into a read-breaking error and diverges from
the established clamping behavior.

---

## D-5 — Resolver-parity GATE outcome (implementation finding, 2026-07-21)

**Status**: RATIFIED-BY-DEFAULT (records the T004 gate result; no construction
change).

**Gate outcome**: GO for the element-boundary construction
`Y.createRelativePositionFromTypeIndex(element, 0)`. Proven via the T004 gate
(`cursor-operations-resolver-parity.test.js`): on a live replica, through the
client's y-prosemirror `relativePositionToAbsolutePosition` over the app schema,
element-boundary anchors resolve **non-null** for every text-less block that can
appear in a VALID ProseMirror document — empty paragraph, image, horizontalRule,
and the empty paragraph that a real empty blockquote / list item actually
contains (the schema requires `block+`/paragraph content, so a rendered "empty
container" is always `container > empty paragraph`, never a bare empty
container). The research R-3 fragment-index fallback was therefore **not
needed**.

**Finding — bare schema-invalid containers (fail-observational, FR-009)**: a
BARE empty container (`blockquote`/`listItem`/`tableCell` with zero children) is
schema-invalid, is dropped on render by ProseMirror, and its boundary position
resolves **null** under the client resolver — with the OLD placeholder-inserting
code too (inserting a bare `Y.XmlText` into a blockquote is still
schema-invalid). CORRECTION (post-merge review F2, 2026-07-21): this shape CAN
occur in a persisted document — the MCP sandbox exposes raw Y constructors with
no schema validation, so a modify script can persist a childless container.
The impossibility claim was overstated; the tested BEHAVIOR is what matters and
is unchanged: for such a shape the
invariant that holds is FR-009: the position math writes **zero bytes** and the
highlight is simply skipped (viewer renders null as no-highlight) — never a
write. Asserted in the resolver-parity test's fail-observational block. This is
an improvement over the old behavior (which wrote garbage and still failed to
render), not a regression.
