# Clarifications Ledger: 030-plugin-logic

Design ground truth: `design/plugin-marketplace-publishing.md` (ratified 2026-07-21), M2 only;
agents.md contract owned by `design/agent-surface-mcp.md`. Per constitution VI, unanswered
product decisions get the best default, recorded here — never decided silently, never blocking.

## RATIFIED-BY-DEFAULT decisions (Sam pre-authorized, 2026-07-21)

### RBD-1 — How the harness consumes the real shared content (bundle assembly, not publish.mjs)

- **Question**: The design says M2 iterates `shared/` content "against the M1 harness", but the harness installs a plugin *bundle* and the only bundle-generator in the design (`publish.mjs`) is M3. What produces the M2 rehearsal bundle?
- **Why it matters**: Building publish.mjs early would smuggle M3 into M2; hand-copying shared content into the stub would recreate exactly the drift the design's generated-copies rule exists to prevent.
- **Default chosen**: A minimal assembly step living with the test harness (not at `distribution/publish.mjs`) generates an installable bundle — manifest skeleton reused from the 029 stub's shape, MCP config, `skills/squire/SKILL.md` from `shared/skill.md`, `commands/onboard.md` from `shared/onboard.md` — with do-not-hand-edit headers pointing at `distribution/shared/`. The harness `--bundle` default switches to this assembled bundle. An agreement check (generated content matches `shared/`) guards drift; the full multi-channel drift CI test stays M3. No mirrors, no schema-validation gate, no pushes.
- **Rationale**: Smallest thing that makes rehearsals exercise the real canonical content while keeping `distribution/` free of M3 artifacts; the parameterized `--bundle` path (029 RBD-9) was designed for exactly this swap.

### RBD-2 — Event-based grading requires structured transcript capture

- **Question**: 029's promotion notes oblige M2 to "grade observable tool-call events over prose", but the M1 harness captures `--output-format text`, which contains no tool-call events. How do events become gradable?
- **Why it matters**: Without event capture, the quote-vs-perform false-PASS vector cannot actually be closed — prose regexes are all the grader can see.
- **Default chosen**: The harness's capture is extended to a structured stream that includes tool-call events (e.g., the client's structured/stream output format) alongside the prose transcript; performable items (byte-channel sync, doc creation/URL) grade against events, prose checks remain for genuinely prose items (coaching lines). If a rehearsal's capture lacks event data, the performable items fail closed rather than falling back to prose.
- **Rationale**: Grading what the agent *did* is the promotion note's stated intent; failing closed keeps a capture regression from silently reopening the false-PASS hole.

### RBD-3 — The gate that consumes rehearsals is the matrix runner, run on demand — not per-commit CI

- **Question**: 029 obliges M2 to wire `--require-claude` into "whatever gate consumes rehearsals", but no consumer exists yet. What is the gate, and does it run in CI?
- **Why it matters**: Model-driven rehearsals are slow, cost real model tokens, and are non-deterministic — a per-commit CI job would be flaky and expensive; but without a defined gate, `--require-claude` guards nothing.
- **Default chosen**: The gate is this feature's matrix runner (FR-030): it always enforces `--require-claude` and per-cell profiles, and refuses to run without model access rather than skipping legs. It is run on demand during iteration and as the pre-sign-off exit check (and before M3 publish), not on every commit. Deterministic derivatives (grader regression fixtures, bundle agreement check, consent-page tests) join the standard suites and DO run on every change.
- **Rationale**: Honors the obligation (no rehearsal can count while its model leg is broken) without adding a nondeterministic, costly CI job the constitution's no-ceremony principle would reject.

### RBD-4 — Per-cell expected-outcome profiles instead of blanket `--require-all`

- **Question**: The grader's `--require-all` demands all seven checklist items pass, but most matrix cells cannot reach all seven (a declined-consent rehearsal never delivers a doc URL; an already-connected cell shows no walkthrough). What does "clean" mean per cell?
- **Why it matters**: Blanket `--require-all` would make most failure-ladder cells unpassable by construction, or force weakening the checklist globally.
- **Default chosen**: Each matrix cell defines an expected-outcome profile: required checklist items, items exempted as unreachable for that scenario, plus cell-specific assertions (e.g., declined-consent must show explain-and-retry coaching; the `.kiro/specs` cell must offer the `.kiro` candidate first). The matrix runner judges each cell against its profile; "clean matrix" = every cell matches its profile in a single full-matrix run with all model legs completed. `--require-all` remains correct for the full happy-path cells.
- **Rationale**: The design fixes what each scenario must exhibit; profiles encode that directly instead of pretending one checklist fits eleven scenarios.

### RBD-5 — Simulating declined consent and abandoned tab: scripted user turns, no new endpoints

- **Question**: The design's matrix includes declined-consent and abandoned-tab cells; the task says harness extensions are in scope if needed. Simulate via new dev endpoints (a "consent-decline" API) or via conversation?
- **Why it matters**: These rungs grade *coaching* — the agent's response to a user-reported event — and every new dev endpoint is a new gated surface to maintain.
- **Default chosen**: Multi-turn cells use a scripted user-simulator: the harness drives the session with scripted user turns reporting the event ("I clicked Deny", "I closed the tab before approving", or pasting the callback URL for the paste-back cell) and the grade targets the agent's coached response. No new server endpoints beyond M1's set.
- **Rationale**: The observable the design cares about (the coaching) lives entirely in the conversation; M1's auto-approve already covers the cases where consent must actually *complete*. Fewer gated endpoints is strictly safer.

### RBD-6 — Headless token-fallback cell mechanics

- **Question**: The token-fallback rung says an `sk_sqd_` token in `~/.squire/token` is treated as fully authenticated — how does the harness stage that state?
- **Why it matters**: The cell must prove the token path proceeds identically to OAuth, using a real token, without leaking token bytes into the transcript.
- **Default chosen**: The harness mints a real `sk_sqd_` token for the fresh synthetic user (via the existing token machinery), writes it to the scratch environment's `~/.squire/token` (scratch HOME, restrictive permissions), and configures the client's MCP auth from that file; no OAuth session exists in the cell. The cell's profile asserts the flow skips the walkthrough and proceeds identically to the connected path, and that the token bytes never appear in the transcript.
- **Rationale**: Uses only existing production token machinery (008/009 lesson: no bespoke auth), and stages exactly the state the design's rung describes.

### RBD-7 — Repo-shape cells via fixture repos

- **Question**: The matrix includes four repo shapes (`.kiro/specs`, `specs/`, `CLAUDE.md`, nothing spec-shaped); the harness currently runs the client in the app repo root. Where do the shapes come from?
- **Why it matters**: Running find-the-spec against the live app repo would make grades depend on this repo's contents and could sync junk docs.
- **Default chosen**: Four small fixture repos live with the test tree (one per shape, each with a README except where the cell tests README-less behavior); the harness copies the cell's fixture to a temp directory and drives the client with that as the working directory. The happy-path/sync cells use the `specs/`-shaped fixture (or `.kiro`) so a real byte-channel sync of a known file can be asserted.
- **Rationale**: Deterministic inputs make profile assertions (candidate offered, precedence order, starter-spec offer) checkable; temp copies keep fixtures pristine across runs.

### RBD-8 — Exact wording of shared content and consent copy

- **Question**: The design fixes required elements and voice but not final prose. Who fixes the words?
- **Why it matters**: Tone is explicitly half of Sam's exit sign-off; freezing exact strings in the spec would pre-empt the iteration loop the milestone exists for.
- **Default chosen**: The spec constrains content testably (required elements, order, semantics, voice, product-name rule); exact prose is authored at implementation and iterated against the harness; Sam's tone sign-off at the exit gate is the final arbiter of wording. Design-fixed elements (e.g., the expectation-setting line's semantics, URL-bare-on-its-own-line) are graded semantically/structurally, not as byte-exact strings.
- **Rationale**: This is exactly the design's M2 method — "iterated against the M1 harness … sign-off on both mechanics and tone".

### RBD-9 — `/squire:onboard` re-run behavior when a spec is already synced

- **Question**: The design specifies the first run; it is silent on running onboard again in a repo whose spec already has a synced doc.
- **Why it matters**: A naive re-run would create duplicate docs — a competing-artifact smell the design indicts elsewhere — and re-runs will happen (users re-run commands).
- **Default chosen**: The flow prefers updating/syncing the existing doc: the sync receipt (frontmatter written back at first sync) identifies the doc, and the import machinery's update/sync intent targets it; creating a new doc happens only when no receipt/doc exists or the user asks for one. The already-connected matrix cell may exercise this.
- **Rationale**: The import tool's create|update|sync intents exist for exactly this; idempotent re-runs match the "doc is born sync-ready" design intent.

### RBD-10 — Grader item 4 ("silent reconnect") graded behaviorally, not by prose regex

- **Question**: The M1 grader's item 4 requires prose matching /reconnect…continue/ — but the design's step 4 says success needs NO ceremony: the flow should just proceed to the spec. Correctly-behaving content could fail item 4 by being correctly silent.
- **Why it matters**: A latent contradiction between the grader and the design would force the content to add ceremony just to pass — the tail wagging the dog.
- **Default chosen**: Item 4 is reworked under grader hardening (FR-027) to grade the behavior: after tool presence is (re-)established, the flow proceeds directly into find-the-spec with no success ceremony (no congratulation/announcement block between consent completion and the spec step). Prose mentioning reconnection is neither required nor penalized.
- **Rationale**: The design text is explicit ("success needs no ceremony — the next thing the user sees is their spec syncing"); the grader must measure that, not its opposite.

### RBD-11 — What counts as the "clean matrix" exit run

- **Question**: Model output is non-deterministic; may cells be retried until they pass?
- **Why it matters**: Retry-until-green would let flaky coaching through the exit gate; zero tolerance for any transient would make the gate practically unreachable.
- **Default chosen**: During iteration, individual cells may be re-run freely (that IS the tuning loop). The exit artifact is a single full-matrix run in which every cell matches its profile with its model leg completed. A cell that passes only intermittently across runs is treated as a content/coaching defect to fix, not a flake to retry away. The exit run's transcripts are archived as Sam's review material.
- **Rationale**: Matches the design's "clean rehearsal transcripts across the full sign-off test matrix" while acknowledging the iteration loop that precedes it.

### RBD-12 — Existing-account-never-consented cell setup and assertion

- **Question**: The design says the agent never distinguishes this state from "no account" — so what does the cell add beyond the fresh-user cell?
- **Why it matters**: If the cell asserted different coaching it would contradict the design's one-path rule.
- **Default chosen**: The cell pre-mints the synthetic account via the M1 faucet before the client starts, expects coaching identical to the fresh cell (same profile for the walkthrough items), and adds one server-side assertion: after consent, exactly one account exists for the identity (find-or-create, no duplicate). Account-creation semantics themselves remain covered by M1's tier-1 tests.
- **Rationale**: Exercises the matrix cell the design names while asserting the only observable difference the design permits (no duplicate account).

## Flagged gaps / discrepancies

1. **M1 grader item 4 contradicts the design's no-ceremony rule** (see RBD-10). The 029 grader requires "reconnect + continue" prose; the design's walkthrough step 4 forbids success ceremony. Resolved in this feature under grader hardening (FR-027) — flagged here because it is a defect in an already-merged M1 artifact, not just an M2 authoring choice.
2. **The M1 harness cannot exercise the walkthrough branch**: it always pre-authorizes via auto-approve before driving the client, so tools are always present and the no-tools coaching branch — the heart of the flow — is never reached. The unauthenticated mode (FR-032) is therefore a required harness extension, not an optimization. The paste-back and failure-ladder cells depend on it.
3. **`--output-format text` carries no tool-call events**, so the promotion-note obligation "grade tool-call events, not prose" implies a capture change to the 029 harness (RBD-2). In scope per the task ("harness extensions … ARE in scope if needed"), but it touches merged M1 code — noted for the plan phase.
4. **Paste-back cell boundary**: in the real flow the OAuth exchange belongs to the MCP client, and a non-interactive session cannot complete the client's own `/mcp` consent mid-run. The cell therefore grades the *coaching* (bare URL, pre-warning, paste-back instruction, handling of the pasted callback URL), with the exchange machinery itself already proven by the M1 tier-2 driver. The one place a full client-native mid-session consent is walked for real is Sam's production self-test — which is exactly the design's division of labor.
5. **Agent Surface doc does not yet carry the signup line** ("signing in with Google creates the account if none exists"). This is per design — the amendment lands "when this ships" (M3). Until then `onboard.md` carries the line without contradicting the doc (the doc is silent, not opposed). Recorded as an M3 obligation (FR-035); M3 must not forget it.
6. **Two `shared/` trees exist**: the constitution's `shared/` (client/server code) and the design's `distribution/shared/` (canonical plugin content). They are unrelated; this spec always says `distribution/shared/` to avoid collision. No conflict, noted to prevent confusion.
7. **Grader item 1's current regex** (`sign(ing)?-in creates … account`) is close to but not exactly the design's expectation-line semantics ("signing in with Google creates your account if you've never used Squire Docs"); as the real content is authored, item 1's matcher may need the same semantic-over-regex treatment as items 4/5/6. Covered by the grader-hardening umbrella (FR-026's fail-closed philosophy), noted so the plan phase checks it.
