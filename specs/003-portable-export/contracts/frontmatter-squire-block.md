# Contract: `squire:` Frontmatter Block & Strip/Preserve Semantics

**Consumers**: feature 002 (import surfaces — targeting via `docGuid`), feature 004 (two-way sync —
baseline reconstruction via `clock`, write-back safety via `lossy`), any external tooling reading
exported files. **Producer**: this feature's export pipeline. **Stability**: this contract is what
002/004 build against — keep it exactly as written; changes require a ledger entry.

## 1. Emission (export with `frontmatter=true`)

The exported file begins with exactly one YAML frontmatter block:

```markdown
---
<foreign keys, verbatim, if any were preserved from a prior import>
squire:
  docGuid: b6edb804-cf72-416d-9c97-063a23e669c0
  title: Payments Service Redesign
  clock: 1482
  exportedAt: 2026-07-13T18:04:11Z
  lastModifiedBy: liz@example.com
  flavor: portable
  lossy: [textStyle]
  images:
    ./assets/payments-service-redesign/9f2c…a1.png: 9f2c…a1
---
<document body>
```

Rules:

- **Single block** (RD-4): foreign keys first, byte- and order-verbatim; regenerated `squire:` key
  appended last. Never two fences.
- **Key order under `squire:`** is fixed as listed below (deterministic emission; supports the M4
  byte-stability invariant for everything except `exportedAt`):
  `docGuid`, `title`, `clock`, `exportedAt`, `lastModifiedBy`, `flavor`, `lossy`, `images`.
- **Conditional keys**: `lossy` present only when at least one mark actually degraded in this export
  (RD-6); `images` present only for bundle exports and only when at least one reference was rewritten.
- **Types**: `docGuid` UUID string; `title` YAML-escaped string; `clock` integer; `exportedAt`
  ISO-8601 UTC (`…Z`); `lastModifiedBy` string; `flavor` ∈ {`squire`, `portable`} (the *effective*
  flavor of this export); `lossy` flow-style list of mark names (registry names, e.g. `underline`,
  `highlight`, `textStyle`); `images` block mapping, keys are the exact relative paths used in the
  body, values are image ids, sorted by key.
- Values are emitted by the in-house emitter with proper YAML quoting for strings that need it
  (titles containing `:`  `#` quotes etc.). Emitted bytes are stable for identical inputs.
- Without `frontmatter=true`: no frontmatter, output byte-identical to today (FR-014/FR-022).
- The body follows the closing fence separated per normal markdown; a body that begins with `---`
  (horizontal rule) is unambiguous because the frontmatter block is already closed (spec Edge Cases).

## 2. Recognition (parse)

`parseFrontmatter(markdown)` → `{ body, squire, foreignRaw }`

A frontmatter block is recognized **iff ALL hold**:

1. The input's first line is exactly `---` (line 1 only — never mid-document).
2. A closing `---` line exists (a subsequent line that is exactly `---`, or `---` at EOF).
3. The enclosed span, fences inclusive, is ≤ **64 KB** (RD-9).
4. The enclosed text parses as YAML (safe load, plain-data schema — never evaluated) to a
   **mapping** (not a scalar/list/null).

If any condition fails → **not frontmatter**: `{ body: <entire input>, squire: null,
foreignRaw: null }`. Never an error, never content loss (FR-016). Consequences: a lone `---` remains
a horizontal rule; an unclosed fence is content; hostile/oversized YAML is content.

On success:

- `squire`: the parsed value of the top-level `squire` key (plain data), or `null` if absent.
- `foreignRaw`: the block's raw inner text minus the `squire:` key's lines (bytes and order
  preserved), or `null` if nothing remains. If the raw-line excision of `squire:` cannot be
  validated against the parsed key set, the **whole** block is treated as foreign
  (`squire: null`, full `foreignRaw`) — conservative fallback, foreign keys are never corrupted.
- `body`: everything after the closing fence (leading blank line removed).

## 3. Trust boundary (Constitution V / FR-016)

- All frontmatter values are **untrusted data**. The YAML load never executes or constructs
  non-plain types; `squire:` fields are advisory metadata only — they confer **no access** and
  trigger **no privileged behavior** at parse time. Authorization always happens at the consuming
  surface (e.g. 004's push endpoint authenticates and checks ACLs regardless of what the file claims).
- Field consumers MUST validate types (e.g. `clock` integer ≥ 0, `docGuid` UUID) before use.

## 4. Round-trip guarantee (SC-005)

For any file `F` with frontmatter: `parseFrontmatter(F)` then re-export with `frontmatter=true`
(carrying `foreignRaw` through) yields a file whose foreign keys are byte-for-byte identical to
`F`'s, in the same order, in a single block, with a freshly regenerated `squire:` key. The `squire:`
block itself is NOT byte-stable across exports (`exportedAt`, `clock` move); it is stripped on
import, so this does not affect the M4 body round-trip invariant.
