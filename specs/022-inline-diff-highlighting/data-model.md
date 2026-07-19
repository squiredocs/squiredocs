# Phase 1 Data Model — Word-Level Two-Tier Inline Diff Highlighting

No database schema change. The "entities" here are in-memory/payload/document-mark shapes
that flow between the diff service and the two renderers.

## E1 — Word segment (`{ text, changed }`)

The atomic unit both renderers consume; produced by the shared helper.

| Field | Type | Meaning |
|-------|------|---------|
| `text` | string | A contiguous run of one side's text (may be whitespace-only). |
| `changed` | boolean | `true` = this run differs from the other side (removed on the before side, added on the after side); `false` = shared with the other side. |

**Invariants**:
- Character-faithful: concatenating a side's segments reproduces that side's exact input
  text (including whitespace).
- Adjacent segments with the same `changed` flag are coalesced (never two `changed:true`
  in a row).
- Unchanged runs (`changed:false`) appear on BOTH sides' segment lists.

**Producer**: `computeWordSegments(before, after)` in `shared/diff/word-diff.js`, which
returns `{ before: Segment[], after: Segment[] }`.

## E2 — `inlineSegments` (chat diff payload field)

Optional additive field on the chat diff payload returned by `computeChatDiff`.

| Field | Type | Meaning |
|-------|------|---------|
| `inlineSegments` | `{ [outputLineIndex: string]: Segment[] } \| undefined` | Map from a diff row's OUTPUT line index (its index in the `lines` array, same keying as `formatAnnotations`) to that row's segment list. `undefined` when no pair produced segments. |

**Relationships / rules**:
- Keys reference removed rows (value = before-segments) and added rows (value =
  after-segments) of paired, non-format-only change blocks only.
- Sits alongside the unchanged `lines`, `hunkStarts`, `formatAnnotations`,
  `truncatedByServer` — none of their meanings change (FR-004).
- On `truncatedByServer`, keys are filtered to `< MAX_DIFF_LINES` (200), mirroring
  `formatAnnotations` (FR-005). No key may reference a truncated-away line.
- Absent field ⇒ render exactly as today (backward-compatible fallback; covers all
  pre-feature persisted tool parts).

## E3 — Version-diff marks `diffInsertWord` / `diffDeleteWord`

Two new ProseMirror marks registered in the shared schema and the editor extension set.

| Mark | Renders as | Tier | Provenance |
|------|-----------|------|------------|
| `diffInsert` (existing) | `<ins>` | subtle (Tier 1) | diff service |
| `diffDelete` (existing) | `<del>` | subtle (Tier 1) | diff service |
| `diffInsertWord` (NEW) | `<ins class="diff-word">` | strong (Tier 2) | diff service ONLY |
| `diffDeleteWord` (NEW) | `<del class="diff-word">` | strong (Tier 2) | diff service ONLY |

**Rules**:
- Produced EXCLUSIVELY by the diff service — no input rules, keyboard shortcuts, or
  editing path creates them (FR-009). Their presence in the schema MUST NOT alter any
  live-document behavior.
- In a refined region every text range carries EXACTLY ONE diff-tier mark (subtle OR
  strong) — tiers never nest (FR-010).
- Splitting a text node at a segment boundary preserves the node's existing formatting
  marks (bold, italic, color, link…) on every resulting piece (FR-010).
- Must round-trip through the registry-driven serialization suite (constitution II).

## E4 — Strong highlight tokens (CSS)

Theme-aware stronger add/remove background colors, defined alongside the existing subtle
diff tint tokens.

| Token | Surface | Location |
|-------|---------|----------|
| `--canvas-diff-add-bg-strong` | version history (`ins.diff-word`) | `client/src/index.css` light block + EVERY dark block |
| `--canvas-diff-del-bg-strong` | version history (`del.diff-word`) | `client/src/index.css` light block + EVERY dark block |
| `.ai-diff-word` (off `--success`/`--danger`) | chat rows | `client/src/components/AiPanel.css` |

**Rule**: derived from the existing add/remove families (no new hue); present in the
light block AND every dark block where the subtle tokens are themed today (FR-013, SC-007).

## State / flow (no state machine)

```
before/after text ──► computeWordSegments ──► { before[], after[] }
   │                                              │
   ├─ chat path:  postProcessDiffLines pairs -/+  ├─► inlineSegments (keyed by output idx)
   │              ► computeChatDiff (filter on trunc) ► DiffView renders .ai-diff-word
   │
   └─ history:    computeMarkdownDiff detects replace region
                  ► apply-word-marks: parse unmarked, split PM text nodes,
                    stamp subtle/strong marks ► VersionPreview renders <ins/del>[.diff-word]
```
Both branches are best-effort: any error falls back to today's line-level output for that
unit (RBD-3).
