# Contract: Theme Control & Resolution

Behavioral contract for the appearance setting, its persistence, resolution, and
pre-paint application. Consumers: the inline bootstrap (`index.html`),
`ThemeContext.jsx`, and `ThemeControl.jsx`.

## Storage contract

- **Key**: `squire-theme` in `localStorage`.
- **Value**: exactly one of `"light"`, `"dark"`, `"system"`.
- **Absent / unrecognized**: treated as `"system"` (defensive; never throws).
- **Written**: only on an explicit user selection. OS-driven re-resolution under
  System does NOT write.

## Resolution contract

`resolvedTheme = resolve(setting, osPrefersDark)`:

| setting | osPrefersDark | resolvedTheme |
|---------|---------------|---------------|
| `light` | any | `light` |
| `dark` | any | `dark` |
| `system` / unknown | `true` | `dark` |
| `system` / unknown | `false` | `light` |

`resolvedTheme` is written to `document.documentElement` as
`data-theme="light"|"dark"`. CSS keys only on this attribute (never on the raw
setting).

## Pre-paint application contract (no-flash, FR-005 / SC-002)

- An inline synchronous `<script>` in `index.html` `<head>`, positioned **before**
  the module bundle (`/src/main.jsx`), MUST run resolution and set `data-theme`
  before the first paint, on **every** route (authenticated or not).
- It MUST be resilient: wrapped so a `localStorage`/`matchMedia` exception cannot
  block rendering (fallback to `light` or OS default without throwing).
- Guarantee: zero frames of wrong-theme content across cold and warm loads.

## Runtime contract (`ThemeContext`)

Exposes:
- `setting`: current tri-state value.
- `resolvedTheme`: current binary value.
- `setSetting(next)`: updates state, persists to storage, updates `data-theme`,
  and (de)registers the `matchMedia` listener as appropriate.

Behavior:
- On mount, reads storage as source of truth and reconciles the attribute (the
  bootstrap already set it; context must not cause a flash or a redundant swap).
- While `setting === "system"`, subscribes to
  `matchMedia('(prefers-color-scheme: dark)')` `change` and re-resolves live
  (FR-003, Story 2) — including with dialogs/menus/AI panel open.
- On unmount/among setting changes, cleans up the listener.
- MUST NOT trigger any document/version/collaboration write (FR-014).

## Control UI contract (`ThemeControl`)

- Renders inside the user profile badge menu (`UserProfileBadge`), on every
  authenticated screen (FR-002).
- Presents exactly three options: **Light**, **Dark**, **System** (FR-001).
- Indicates the currently active setting (FR-002) — e.g. selected state /
  checkmark / segmented highlight.
- Selecting an option calls `setSetting`; the app restyles immediately, no reload
  (FR-006, SC-001).
- Accessible: keyboard-operable, labeled, focus-visible using `--focus-ring`.
- Unauthenticated screens (login, legal) render **no** control; they inherit the
  pre-paint-resolved theme from storage-or-OS (D2).

## Acceptance mapping

| Behavior | Spec |
|----------|------|
| Three states, default System | FR-001, US Story 1/2 |
| Control in profile menu, shows active | FR-002 |
| System follows OS live | FR-003, Story 2 |
| Explicit choice persists per device | FR-004 |
| No flash before first paint, all routes | FR-005, SC-002 |
| All chrome restyles, no reload | FR-006, SC-001, SC-003 |
| Purely presentational (no writes) | FR-014, SC-006 |
