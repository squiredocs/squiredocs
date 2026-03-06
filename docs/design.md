# Squire Docs Design Guidelines

Brand identity, visual language, and UX principles for Squire Docs.

---

## Brand Identity

**Product**: Squire Docs
**URL**: squiredocs.com

**What it is**: A collaborative document editor that removes the friction from how people actually work today. It feels like the doc editor you already know — but with AI woven into the editing experience so naturally that the old workflow (write, copy to a chat tool, copy back, fix formatting) feels broken in hindsight.

Think Cursor or Claude Code, but for documents. Those tools didn't invent code editors or AI — they just made the integration so seamless that going back felt absurd. Squire Docs is that same shift for everyday document work.

**Audience**: Anyone who uses Google Docs. Writers, teams, knowledge workers. The product is intentionally broad — documents are universal.

**Core value proposition**: The best tools disappear into your workflow. Squire Docs makes AI a natural part of writing and editing — present when you need it, invisible when you don't. Every change is tracked and reversible, so you stay in control.

### Brand Personality

- **Familiar** — Feels like the doc editor you already know. No learning curve, no new mental model. You open it and start writing.
- **Seamless** — AI isn't a separate tool you visit. It's in the document with you, editing alongside you. The integration is the product.
- **Accountable** — Every change, human or AI, is tracked with full attribution. You can see who did what, compare any version, and restore any state. You're always in control.
- **Frictionless** — The product removes steps from your workflow instead of adding them. No copy-pasting between tools, no reformatting, no context-switching.

---

## Visual Language

### Overall Aesthetic

Clean, professional, document-centric. The interface disappears behind the content. Familiar enough to feel productive immediately — you should be able to open Squire Docs and start writing without thinking about it — but refined enough to feel like its own product, not a clone.

**Theme**: Light only (no dark mode). White surfaces, light gray backgrounds for depth, purple as the primary accent.

### Color Palette

#### Primary — Purple

Purple is the brand color. It signals interactivity and distinguishes Squire Docs from the blue/green palette of most productivity tools.

| Role | Hex | Usage |
|------|-----|-------|
| Primary | `#7c3aed` | CTAs, AI features, active states, send button, FAB |
| Primary hover | `#6d28d9` | Button hover states |
| Primary light | `#f3e8ff` | Light backgrounds, selection highlights |
| Primary muted | `#c4b5fd`, `#a78bfa` | Secondary accents, decorative |
| Primary wash | `#f5f3ff`, `#f3f0ff` | Tinted panel backgrounds (e.g. "New document" button) |

#### Neutrals

| Role | Hex | Usage |
|------|-----|-------|
| Text primary | `#1f2937`, `#333` | Headings, body text, titles |
| Text secondary | `#6b7280` | Descriptions, timestamps, placeholders |
| Text tertiary | `#9ca3af` | Copyright, helper text |
| Border | `#e0e0e0`, `#e5e7eb`, `#dadce0` | Dividers, card borders, input borders |
| Surface | `#ffffff` | Primary background |
| Surface raised | `#f8f9fa`, `#f9fafb` | Section backgrounds, list hovers |
| Surface muted | `#f1f3f4`, `#f5f5f5` | Toolbar backgrounds, disabled areas |

#### Semantic

| Role | Hex | Usage |
|------|-----|-------|
| Success/Connected | `#4caf50`, `#16a34a` | Connection status, shared indicators |
| Danger | `#dc2626` | Delete actions, stop button, errors |
| Warning | `#ffc107` | Connecting state, caution |
| Link | `#2563eb` | Inline links in document content |
| Active/Selected | `#1a73e8` | Toolbar active buttons |

#### Gradients

- **Brand gradient**: `linear-gradient(135deg, #667eea 0%, #764ba2 100%)` — used for avatar fallbacks and decorative elements
- **Hero gradient**: `linear-gradient(180deg, #ffffff 0%, #f9fafb 100%)` — subtle page section transitions

### Typography

**System font stack** — no web fonts. Fast, native, familiar.

```
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
```

Monospace (code blocks):
```
font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'Courier New', monospace;
```

#### Type Scale

| Element | Size | Weight | Line Height | Letter Spacing |
|---------|------|--------|-------------|----------------|
| Landing headline | 3.5rem | 800 | 1.1 | -0.03em |
| Section title | 2.25rem | 700 | 1.2 | -0.02em |
| Page title (h1) | 28–32px | 700 | 1.2 | — |
| Subheading (h2) | 24px | 600 | 1.3 | — |
| Subheading (h3) | 20px | 600 | 1.3 | — |
| Body | 16px | 400 | 1.5 | — |
| UI text (buttons, labels) | 14–16px | 500–600 | 1.2 | — |
| Small/helper | 12–13px | 400–500 | 1.4 | — |

### Spacing

Follows a loose 4px base grid: `4, 6, 8, 12, 16, 20, 24, 32, 48`.

Content areas use generous horizontal padding (96px on desktop, 16px on mobile) to keep the document feeling spacious and focused, with compact vertical padding (32px on desktop). No page borders — the editor content floats cleanly in the white surface. Max content width is 816px for the editor.

### Border Radius

| Context | Radius |
|---------|--------|
| Buttons, inputs | 4–8px |
| Cards, panels | 12px |
| Signup cards, modals | 16px |
| Pill buttons (e.g. Google CTA) | 9999px |
| Avatars, send button | 50% |

### Shadows

Shadows are restrained — used to lift interactive elements, not for decoration.

- **Subtle**: `0 1px 3px rgba(0,0,0,0.1)` — header, light cards
- **Medium**: `0 2px 10px rgba(0,0,0,0.15)` — dropdowns, popovers
- **Hero**: `0 20px 60px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05)` — landing page screenshots

---

## Component Patterns

### Buttons

- **Primary**: Purple fill (`#7c3aed`), white text. Hover darkens to `#6d28d9`. Used for primary actions: "New document", "Send", AI FAB.
- **Secondary**: White fill, gray border, gray text. Hover shows light gray background. Used for cancel, filter, navigation.
- **Danger**: Red fill or red text. Used for delete, stop.
- **Icon buttons**: 28–36px square, borderless or light border, subtle hover background.

### Cards & Containers

- White background, 1px light gray border, 12px radius
- Hover state on interactive cards: slight lift (`translateY(-4px)`), purple border tint, faint purple shadow

### Forms & Inputs

- 1px border `#dadce0`, 4–8px radius
- Focus: border transitions to purple, optional purple box-shadow glow
- Error: red text on light red background
- Success: green text on light green background

### Toolbar

- Horizontal bar of icon buttons below the header on editor pages
- Active/selected button gets blue background (`#1a73e8`) with white icon
- Grouped by function with subtle dividers
- Includes: text formatting, font family, font size, text/highlight color, headings, lists, blockquote, code, link, table

### AI Chat Panel

- Dockable panel: right side (380px), bottom (300px), or pop-out
- White background, same border/shadow treatment as other panels
- User messages: purple background, white text
- AI messages: light gray background (`#f3f4f6`), dark text
- AI renders rich markdown: headings, bold, italic, lists, code blocks
- Send button: purple circle, white arrow icon
- Typing indicator: pulsing dots animation

### Document List

- Clean list with document icon, title, and timestamp per row
- Purple document icon (SVG)
- Hover: light gray background
- Search bar and filter dropdown at top
- Three-dot menu per row for actions (rename, delete, share)

### Version History

- Right-side panel on desktop
- Grouped by month, expandable entries
- Each version shows timestamp, clock range, and author dots (color-coded)
- "Highlight changes" toggle with green/red diff highlighting in the document
- Restore button per version

---

## Layout & Navigation

### App Shell

```
┌─────────────────────────────────────────────┐
│  Header: [Logo] [Title] ... [Collab] [Menu] │
│  Toolbar: [B I U S ...] [Font] [Size] ...   │
├──────────────────────────┬──────────────────┤
│                          │                  │
│     Document Content     │   AI Chat Panel  │
│     (max 816px)          │   (380px)        │
│                          │                  │
└──────────────────────────┴──────────────────┘
```

- **Header**: Fixed. Logo (purple doc icon + "Squire Docs"), editable title input, collaborator avatars, tools menu, AI toggle.
- **Toolbar**: Sticky below header on editor pages. Formatting tools, disappears on non-editor pages.
- **Content area**: Centered, max-width 816px, generous horizontal padding.
- **AI Panel**: Toggled via floating action button (bottom-right, purple). Can dock right, bottom, or pop out.

### Responsive Behavior

| Breakpoint | Behavior |
|------------|----------|
| > 768px | Full desktop layout, side-docked AI panel |
| 481–768px | Tablet, reduced padding, bottom-docked panel |
| ≤ 480px | Mobile, full-width panels, touch-friendly 44px targets, fixed header |

---

## Motion & Interaction

### Principles

- **Subtle and functional** — animation communicates state changes, not decoration
- **Fast** — most transitions are 0.15s, max 0.3s
- **CSS-only** — no animation libraries; `@keyframes` and `transition` only

### Transitions

- **Default**: `0.15s ease` on `background-color`, `border-color`, `color`, `box-shadow`
- **Hover lift**: `transform: translateY(-2px)` on cards and CTAs
- **Focus glow**: `box-shadow` transition on inputs

### Animations

- **Spinner**: 360deg rotation, 0.8s linear infinite
- **AI typing dots**: Scale + opacity pulse, 1.2s ease-in-out
- **Avatar fade-in**: Opacity 0→1, 0.3s ease-out
- **Collaboration cursors**: Smooth caret color with label fade-in

---

## Key UX Principles

1. **The document is the interface** — Minimize chrome. The editor content area should dominate the viewport. Tools appear contextually and stay out of the way.

2. **AI is a collaborator, not a modal** — The AI chat panel is always accessible but never intrusive. It docks beside the document, not on top of it. AI edits appear inline with visual attribution.

3. **Everything is reversible** — Full version history with per-edit granularity. Users should never fear making changes or letting AI make changes.

4. **Attribution is clear** — Every version entry shows who (human or AI) made what changes. Collaboration cursors show presence. The user always knows what happened and who did it.

5. **Familiar patterns, no learning curve** — Standard document editor conventions (Google Docs-like toolbar, keyboard shortcuts). New features (AI, version history) are additive, not disruptive.

6. **Progressive disclosure** — Core editing works with zero setup. AI panel, version history, sharing, and MCP integrations are discovered as needed.

---

## Logo & Brand Mark

- **Icon**: Purple document SVG with downward arrow motif (suggesting "bringing content in")
- **Wordmark**: "Squire Docs" in bold sans-serif (system font, 700 weight, -0.02em tracking)
- **Color**: Purple (`#7c3aed`) for icon, dark gray (`#1f2937`) for text
- **Minimum size**: 32px icon, typically paired with text at 1.5rem

---

## Pages

| Page | Purpose | Key Design Notes |
|------|---------|-----------------|
| Landing (`/`) | Marketing/signup | Hero headline, feature cards, product screenshots, Google sign-in CTA |
| Login (`/login`) | Authentication | Centered card, Google OAuth button, purple accents |
| Documents (`/docs`) | Document list | Clean list, search + filter, "New document" button |
| Editor (`/d/:id`) | Core product | Full editor with toolbar, AI panel, real-time collab |
| Version History (`/d/:id/versions`) | Audit trail | Editor + right panel with grouped version entries and diff highlighting |
| Settings (`/settings`) | User prefs | Profile editing, display name, MCP configuration |
