# Dark-mode AA contrast audit (T051, FR-011 / SC-004)

Programmatic WCAG 2.1 contrast audit of the **dark** palette against its intended
surfaces, plus the U3 collaborator identity-color legibility check. Ratios
computed with the WCAG relative-luminance formula (sRGB), including alpha
compositing for the translucent presence ring. Re-run:
`node client/scripts/... ` — the calc lives in the T051 audit command in the
implementer log; values below are current as of the token tuning commit.

## Text & UI contrast (all PASS after tuning)

| Pair | Ratio | Need | Result |
|------|-------|------|--------|
| text-primary `#e6e8eb` / surface-raised `#1a1d23` | 13.75 | 4.5 | PASS |
| text-primary / surface-base `#0f1115` | 15.39 | 4.5 | PASS |
| text-primary / surface-overlay `#21252c` | 12.53 | 4.5 | PASS |
| text-secondary `#aab1bb` / surface-raised | 7.81 | 4.5 | PASS |
| text-tertiary `#838a94` / surface-raised | 4.85 | 4.5 | PASS |
| canvas-text `#e6e8eb` / canvas-bg `#17191d` | 14.34 | 4.5 | PASS |
| canvas-text-muted `#aab1bb` / canvas-bg | 8.14 | 4.5 | PASS |
| text-link `#b79dff` / surface-raised | 7.46 | 4.5 | PASS |
| canvas-link `#6ea8ff` / canvas-bg | 7.30 | 4.5 | PASS |
| **on-accent `#14171c` / accent `#9a72f7`** | **5.24** | 4.5 | PASS *(tuned: accent `#8b5cf6`→`#9a72f7`)* |
| danger `#f87171` / surface-raised | 6.10 | 4.5 | PASS |
| success `#4ade80` / surface-raised | 9.69 | 4.5 | PASS |
| warning `#fbbf24` / surface-raised | 10.11 | 4.5 | PASS |
| info `#60a5fa` / surface-raised | 6.64 | 4.5 | PASS |
| accent icon `#9a72f7` / surface-raised (UI) | 4.92 | 3.0 | PASS |
| **border-strong `#626b7a` / surface-base (UI)** | **3.51** | 3.0 | PASS *(tuned: `#545c68`→`#626b7a`)* |
| border-strong / surface-raised (UI) | 3.14 | 3.0 | PASS |
| focus-ring `#b79dff` / surface-raised (UI) | 7.46 | 3.0 | PASS |
| focus-ring / canvas-bg (UI) | 7.78 | 3.0 | PASS |

### Two token tunes made by this audit (contract sanctions this — values are tunable within AA)
- Dark `--accent`: `#8b5cf6` → `#9a72f7`. The near-black `--on-accent` label on a
  solid accent button was 4.24 (fail); the brighter accent lifts it to 5.24 while
  keeping the accent-as-icon use ≥3:1 on dark chrome (4.92).
- Dark `--border-strong`: `#545c68` → `#626b7a` to clear 3:1 for control
  boundaries on both `--surface-base` and `--surface-raised`.

### Decorative-border note (accepted, not a failure)
`--border-default` (dark `#3a414b`) is ~1.6–2.0:1 against dark surfaces. WCAG
1.4.11 requires 3:1 only for boundaries that are the sole means of identifying a
control/state — not decorative dividers/card outlines, which is what
`--border-default`/`--border-subtle` are. Interactive controls get their
perceivable boundary from `--focus-ring` (7.46:1) on focus and `--border-strong`
(3.14:1) where a resting boundary must be perceived. Keeping default dividers
subtle is intentional; raising them to 3:1 would read as heavy boxes.

## U3 — Collaborator identity-color legibility on dark (D14/D18/FR-012)

The user→color mapping (`colorUtils.js`) is **unchanged**. The darkest Kelly
color, **Dark Olive Green `#2B3D26`**, is only 1.45:1 against dark chrome
`#1a1d23` as a raw fill — i.e. an identity chip alone would be nearly invisible.
The **`--presence-ring`** affordance (T042) supplies the separation instead:

| Measure | Ratio | Need |
|---------|-------|------|
| presence-ring (white α.55 over `#1a1d23`) vs surface-raised | 5.93 | 3.0 |
| presence-ring vs Dark Olive Green chip `#2B3D26` | 4.10 | 3.0 |
| presence-ring over canvas vs canvas-bg `#17191d` | 6.09 | 3.0 |

So every identity chip (collaborator avatar, version author dot, canvas cursor
caret + label) is bounded by a ring ≥3:1 against both the surrounding surface and
the darkest identity fill — the chip is always locatable and its ring legible,
without altering the identity mapping. In light mode the ring is a subtle dark
hairline (α.35 black), a minor, non-regressive separation.

## Motion
Theme switching adds no animation; the global `prefers-reduced-motion` reduce
block in `index.css` is unchanged. The small `transition` on `--presence-ring`
carriers and the theme control are color/opacity transitions already covered by
that global reduce rule.

## Not covered here (manual, per orchestrator V1)
- No-flash (SC-002) is verified manually via `quickstart.md` (no browser E2E
  infra built) — see promotion-notes.
- Full visual sweep of all 35+ surfaces (T052/SC-003) is a manual reviewer pass;
  the mechanical `lint:colors` gate proves *zero unthemed literals* remain, which
  is the structural half of SC-003.
