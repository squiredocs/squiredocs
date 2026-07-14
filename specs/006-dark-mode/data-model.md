# Phase 1 Data Model: Dark Mode

This feature is client-only and presentational: there is **no database entity,
no server record, no migration**. The "data" is (1) a device-local preference
value and its resolution, and (2) the semantic color-token registry. Both are
modeled here.

## Entity 1 — Appearance Preference (device-local)

| Field | Type | Values | Notes |
|-------|------|--------|-------|
| setting | enum | `light` \| `dark` \| `system` | The user's chosen setting. Absent/unrecognized in storage → treated as `system`. |
| resolvedTheme | enum (derived) | `light` \| `dark` | What CSS actually applies. Derived, never stored. |

**Storage**: `localStorage`, key **`squire-theme`**, value is the `setting`
string. Device- and browser-local (D3). No account/server persistence in v1.

**Resolution function** (pure):

```
resolve(setting, osPrefersDark):
  if setting == "light" -> "light"
  if setting == "dark"  -> "dark"
  else /* system or unknown */ -> osPrefersDark ? "dark" : "light"
```

`osPrefersDark = matchMedia('(prefers-color-scheme: dark)').matches`.

**Application**: `resolvedTheme` is written to
`document.documentElement.dataset.theme` (attribute `data-theme`). CSS keys only
on this binary attribute. The tri-state `setting` lives only in JS/localStorage.

**State transitions**:

| From setting | Event | To setting | resolvedTheme effect |
|--------------|-------|-----------|----------------------|
| any | user picks Light | `light` | → `light`; persisted; attribute updated; matchMedia listener detached |
| any | user picks Dark | `dark` | → `dark`; persisted; attribute updated; matchMedia listener detached |
| any | user picks System | `system` | re-resolve from OS; persisted; matchMedia listener attached |
| `system` | OS appearance changes | `system` (unchanged) | re-resolve live; attribute updated; no persistence write needed |
| (none stored) | first load | effective `system` | resolved from OS at pre-paint |

**Validation / invariants**:
- Unknown/corrupt stored value MUST be treated as `system` (defensive read).
- Applying a theme MUST NOT write to any document, version, or collaboration
  state (FR-014) — this entity is isolated from document data entirely.
- Persistence write happens only on explicit user choice; OS-driven re-resolves
  under System do not rewrite storage.

**Lifecycle / read points**:
1. **Pre-paint** (inline bootstrap in `index.html`): read storage → resolve →
   set attribute, before the bundle loads (FR-005, D11).
2. **Runtime** (`ThemeContext`): re-read as source of truth on mount, own
   setter, persist, update attribute, manage matchMedia subscription.

## Entity 2 — Semantic Color Palette (CSS token registry)

Not a runtime object; the canonical set of CSS custom properties defined in
`client/src/index.css` `:root`, with a light realization (default) and a dark
realization (`:root[data-theme="dark"]` + scoped `prefers-color-scheme` media
fallback). Full authoritative role list and light/dark values live in
[`contracts/color-tokens.md`](./contracts/color-tokens.md). Summary of role
groups:

| Role group | Example tokens | Purpose |
|------------|----------------|---------|
| Surfaces | `--surface-base`, `--surface-raised`, `--surface-overlay`, `--surface-sunken`, `--surface-hover`, `--surface-active`, `--surface-selected` | App/panel/menu/dialog backgrounds and interactive-surface states |
| Text | `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-disabled`, `--text-inverse`, `--text-link` | Text tiers and on-accent/link text |
| Borders | `--border-subtle`, `--border-default`, `--border-strong`, `--focus-ring` | Dividers, outlines, focus visibility |
| Accent | `--accent`, `--accent-hover`, `--accent-active`, `--accent-subtle`, `--on-accent` | Brand violet actions and tints |
| Feedback | `--danger`, `--danger-subtle`, `--success`, `--warning`, `--info` (+ text/bg variants as needed) | Error/success/warning/info states |
| Elevation | `--shadow-sm/md/lg`, `--backdrop` | Shadows (softened in dark), modal scrim |

**Invariants**:
- Every color used by themed chrome MUST reference a semantic role token; no raw
  literal may remain outside the token-definition block and the canvas allowlist
  (FR-013, enforced by the D13 lint).
- The dark realization MUST meet WCAG 2.1 AA for text (4.5:1) and meaningful UI
  components/states (3:1), including hover/focus/selection/disabled visibility
  (FR-011, SC-004).
- Canvas tokens are intentionally **out of scope** of this registry: the
  document canvas is not tokenized (D12); it keeps fixed light values.

## Entity 3 (excluded) — Presence identity color

The user→color mapping (`colorUtils.js` `PALETTE`) is an existing entity that
this feature **does not modify** (D8/FR-012). It is listed here only to state the
non-change explicitly: no field, storage, or mapping changes; dark-mode
legibility is handled by chrome presentation tokens (D14), not by altering this
mapping.
