# Data Model: Plugin Logic (Plugin M2)

Phase 1 for `030-plugin-logic`. M2 introduces no database schema — these are the *conceptual entities* the content, tooling, and gate operate on (from the spec's Key Entities), with their fields, relationships, and validation rules. Persistence is files in the repo and archived transcripts, not tables.

## Canonical shared artifact set

The single source of truth for plugin coaching content.

- **skill.md** (`distribution/shared/skill.md`) — the when-to-use-Squire-Docs steering body.
  - Fields (required content elements, FR-002/003/004): the standing loop (sync-before / read-at-start / write-back-after); the byte-channel rule (bytes-outside-the-model move over REST import/export, never retyped through tool params, even after reading); token handling (`~/.squire/token`, 0600, referenced not printed, never in transcript/echo/argv).
  - Validation: says "Squire Docs" never bare "Squire" (FR-006); honest-confident voice; agrees with `design/agent-surface-mcp.md` (FR-005, no fork).
- **onboard.md** (`distribution/shared/onboard.md`) — the `/squire:onboard` flow body.
  - Fields: entry-state detection by tool presence only (FR-007); the four walkthrough steps in order (FR-008..011); the command-availability caveat (FR-012); the four failure-ladder rungs and nothing else (FR-013); the five moves — connect / find-spec / byte-faithful sync / payoff / teach-loop (FR-014..017); re-run-prefers-update behavior (FR-018).
  - Validation: same product-name/voice/contract-agreement rules; design-fixed elements present (expectation-line-before-browser, URL bare on its own line); no invented auth path (008/009 lesson).
- Relationships: both are generated FROM by the rehearsal bundle; both cross-checked AGAINST the Agent Surface contract (SC-006). No other authoritative copy exists (FR-001).

## Rehearsal bundle (generated, do-not-hand-edit)

The installable plugin bundle assembled from `shared/` for harness consumption.

- Fields: `.claude-plugin/plugin.json` (name `squire`), `.claude-plugin/marketplace.json`, `.mcp.json` (endpoint templated to the dev server by the harness at run time), `skills/squire/SKILL.md` (← `skill.md`), `commands/onboard.md` (← `onboard.md`). Each generated content file carries a do-not-hand-edit header pointing at `distribution/shared/`.
- Validation: content region byte-matches `shared/` (agreement check, FR-021); source `shared/` never mutated by assembly/rehearsal (FR-019); NOT `distribution/publish.mjs` and introduces no mirrors/manifests/registry entries (FR-020).
- Relationships: consumed by the 029 harness `--bundle` (its M2 default); explicitly not the shipping bundle (that's M3, when `distribution/claude-plugin` exists — FR-035).
- State: `shared/` (source) → *assemble* → generated bundle → *agreement-check* → (pass) install into scratch client / (fail) run aborts.

## Coaching contract checklist (hardened)

The seven-item grading contract from 029, hardened per the promotion notes. See `contracts/coaching-checklist.md` for the full item definitions.

- Items 1–3, 7: **prose** items (coaching lines), graded semantically against the prose stream. Item 1's matcher tracks the authored expectation-line semantics (ledger gap 7 / FR-026 fail-closed).
- Item 4 (silent reconnect): **behavioral** — after tool presence (re-)established, flow proceeds to find-spec with no success-ceremony block; reconnection prose neither required nor penalized (FR-027, RBD-10).
- Item 5 (byte-channel sync): **performable** — graded from a tool-call event (byte-channel `curl` import / `import_markdown_file` recipe run), not prose (FR-026).
- Item 6 (doc-URL payoff): **performable** — passes only for a URL on the rehearsal-server origin AND corroborated by a doc-creating/import tool-call event (FR-025).
- Validation: performable items fail closed when event data is absent (RBD-2). Prose items graded semantically, not byte-exact (RBD-8), except design-fixed structural elements (URL bare on its own line).

## Structured rehearsal transcript

The captured session — the graded artifact and Sam's review material.

- Fields: prose stream (assistant text) + ordered tool-call event list (tool name, input, result where present), parsed from `--output-format stream-json` (R1). Archived per matrix cell.
- Validation: token bytes never present (token-fallback cell assertion, RBD-6); where events are expected but absent, performable items fail closed.
- Relationships: produced by the harness model leg; consumed by the grader; archived by the matrix runner for the exit record.

## Matrix cell + expected-outcome profile

One scenario of the sign-off matrix paired with its grading profile. See `contracts/matrix-cell-profile.md` for the schema and all 11 cells.

- Fields per cell: `id`/name; harness `mode` (unauthenticated / pre-authorized / token-fallback); fixture repo; scripted user turns (if any); `profile` = { required checklist items, exempted-as-unreachable items, cell-specific assertions }.
- The 11 cells: fresh-user happy path · existing-account-never-consented · already-connected · declined-consent · abandoned-tab · remote-paste-back · headless-token-fallback · repo-shape `.kiro/specs` · repo-shape `specs/` · repo-shape `CLAUDE.md` · repo-shape nothing-spec-shaped.
- Validation (RBD-4/11): "clean" = every cell matches its profile in a single full-matrix run with all model legs completed; happy-path cells use the full checklist; failure-ladder cells require their rung's coaching and are exempted from unreachable items.
- Cell-specific assertions of note: existing-account cell asserts exactly one account after consent (find-or-create, no duplicate — FR-033/RBD-12); token-fallback cell asserts token bytes never in transcript (RBD-6); `.kiro` cell asserts `.kiro` candidate offered first (precedence); nothing-spec-shaped cell asserts a starter-spec offer drawn from README/repo structure.

## Consent first-run surface

The consent page's unauthenticated state, reframed as the product's first impression.

- Fields (required elements, FR-022/023): a "Continue with Google" primary action; a same-click-creates-account line; one line for what Squire Docs is (the durable, attributed spec layer for agentic development); one line for what the agent is asking to do; one line that every agent edit is attributed and revertible.
- Validation: copy/presentation only (FR-024) — `returnTo` round-trip, OAuth-param carriage, `agent_oauth` provenance stamping, welcome-doc skip all unchanged (tier-1 tests green); authenticated consent card unchanged; three one-liners must not push the primary action below the fold on common mobile viewports; "Squire Docs" / honest-confident voice; final wording is Sam's tone sign-off (exit).
- Relationships: covered by a new Vitest client test (SC-005); server behavior behind it is M1-verified and reused.

## Exit sign-off record + M3 obligations record

The recorded artifacts that gate M3.

- **Exit sign-off record** (FR-034): the twofold gate — (a) a clean full-matrix run (archived transcripts + per-cell grades); (b) Sam's HITL sign-off on mechanics AND tone from the production self-test (M1 single-account reset + `selftest@example.com` + real browser vs prod). Fields: date, scope (mechanics+tone), transcript references. M3 must not begin, and nothing is published, before this record exists (SC-007).
- **M3 obligations record** (`promotion-notes.md`, FR-035): the Agent Surface signup-line amendment at ship time; agents.md / documentation-site / landing-page updates; real per-channel manifests + mirror repos + `publish.mjs` + full drift CI test replacing the rehearsal assembly; harness default `--bundle` → `distribution/claude-plugin` when it exists.
- Relationships: the sign-off record consumes the matrix runner's archived output; the obligations record hands forward to feature 031+ (M3).
