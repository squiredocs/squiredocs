# Contract: Semantic Color Token Registry

The UI contract for the token layer. This is the canonical list of semantic role
tokens that **all themed chrome MUST consume** and that the theme swap
redefines. It also defines the **canvas allowlist** the migration lint (D13)
uses. Exact hex values are implementation-tunable *within the AA contrast
constraint* (FR-011); the **role names and the light↔dark contract** are fixed
here so every migrated file targets the same vocabulary.

## Definition location & structure

Defined in `client/src/index.css` `:root`, in two tiers:

```css
:root {
  /* --- Tier 1: primitives (raw values, not consumed directly by chrome) --- */
  --violet-600: #7c3aed;  --violet-700: #6d28d9;  --violet-50: #f5f3ff;  --violet-100: #ede9fe;
  --gray-50: #f9fafb; --gray-100: #f3f4f6; --gray-200: #e5e7eb; --gray-300: #d1d5db;
  --gray-400: #9ca3af; --gray-500: #6b7280; --gray-700: #374151; --gray-800: #1f2937; --gray-900: #111827;
  --red-600: #dc2626; --amber-700: #92400e; --green-600: #16a34a; --blue-600: #2563eb;
  --white: #ffffff; --black: #000000;

  /* --- Tier 2: semantic roles (the ONLY thing chrome CSS references) --- */
  --surface-base: var(--gray-100);      /* app background (was #f5f5f5) */
  --surface-raised: var(--white);       /* panels, cards, menus */
  --surface-overlay: var(--white);      /* dialogs, dropdowns, popovers */
  --surface-sunken: var(--gray-50);     /* wells, insets, chat code bg */
  --surface-hover: var(--gray-100);
  --surface-active: var(--gray-200);
  --surface-selected: var(--violet-50);
  --text-primary: #333;                 /* was #333 / #1f2937 */
  --text-secondary: var(--gray-500);
  --text-tertiary: var(--gray-400);
  --text-disabled: var(--gray-300);
  --text-inverse: var(--white);
  --text-link: var(--violet-600);
  --border-subtle: var(--gray-200);
  --border-default: var(--gray-300);
  --border-strong: var(--gray-400);
  --focus-ring: var(--violet-600);
  --accent: var(--violet-600);
  --accent-hover: var(--violet-700);
  --accent-active: var(--violet-700);
  --accent-subtle: var(--violet-50);
  --on-accent: var(--white);
  --danger: var(--red-600);
  --danger-subtle: #fef2f2;
  --success: var(--green-600);
  --warning: var(--amber-700);
  --info: var(--blue-600);
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.06);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.10);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.15);
  --backdrop: rgba(0,0,0,0.40);
}

:root[data-theme="dark"] {
  /* Redefine the semantic layer only (primitives reused / a few added). */
  --surface-base: #0f1115;
  --surface-raised: #1a1d23;
  --surface-overlay: #21252c;
  --surface-sunken: #14171c;
  --surface-hover: #262b33;
  --surface-active: #2f353f;
  --surface-selected: #2a2440;
  --text-primary: #e6e8eb;   /* tune to AA on --surface-raised */
  --text-secondary: #a1a7b0;
  --text-tertiary: #7c828c;
  --text-disabled: #565c66;
  --text-inverse: #14171c;
  --text-link: #b79dff;
  --border-subtle: #2a2f37;
  --border-default: #363c45;
  --border-strong: #4a515c;
  --focus-ring: #b79dff;
  --accent: #8b5cf6;
  --accent-hover: #a78bfa;
  --accent-active: #a78bfa;
  --accent-subtle: #2a2440;
  --on-accent: #14171c;
  --danger: #f87171;
  --danger-subtle: #3a1d1d;
  --success: #4ade80;
  --warning: #fbbf24;
  --info: #60a5fa;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
  --shadow-md: 0 2px 8px rgba(0,0,0,0.5);
  --shadow-lg: 0 8px 24px rgba(0,0,0,0.6);
  --backdrop: rgba(0,0,0,0.6);
}

/* System-before-hydration fallback: apply dark values when OS prefers dark AND
   no explicit resolved attribute is present. Scoped so an explicit
   [data-theme="light"] always wins. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) { /* ...same dark overrides... */ }
}
```

> Dark hex values above are a **starting proposal**; the AA audit task (US1) may
> tune any of them. What is contractual: the role names, that dark redefines the
> semantic tier wholesale, and that every value passes AA in its intended
> context.

## Consumption contract

- Every themed chrome declaration referencing a color MUST use a `var(--role)`
  token from the semantic tier — never a primitive directly, never a literal.
- Interactive elements MUST use the `*-hover` / `*-active` / `--surface-selected`
  / `--focus-ring` roles for their states so state visibility meets AA in both
  themes (FR-011, edge case: selection/focus/scrollbars/hover).
- Shadows and the modal backdrop use the elevation tokens (shadows are stronger
  in dark to preserve separation on dark surfaces).

## Canvas exclusion set (NOT tokenized — stays light; D12)

The migration lint treats these as the **allowlist** where raw color literals
remain legal:

| File / selector | Reason |
|-----------------|--------|
| `EditorCommon.css` — `.editor-common-content`, `.editor-common-content .ProseMirror` and content descendants | Shared document-content canvas (editor + previews); light paper |
| `VersionPreview.css` — the document-content preview area only (surrounding chrome IS tokenized) | Renders document content on light canvas |
| `DiagramNodeView.css` — rendered-diagram content styling | On-canvas embedded content |
| `ImageNodeView.css` — image content styling | On-canvas embedded content |
| Print styles (`@media print` blocks) | Print is theme-independent (D7/FR-010) |
| `index.css` token-definition region (the `:root` / `[data-theme]` blocks) | This is where literals are legally defined |

Any literal outside this set is a lint failure. The allowlist is encoded in
`client/scripts/check-color-tokens.mjs` and kept in sync with this table.
