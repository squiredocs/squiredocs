---

description: "Task list for feature 030-plugin-logic (Plugin M2)"
---

# Tasks: Plugin Logic (Plugin M2)

**Input**: Design documents from `/specs/030-plugin-logic/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Tests**: Included where the test IS the deliverable — the consent-page client test (FR-024), grader regression fixtures (FR-028), and the bundle agreement check (FR-021) are required product artifacts, not optional TDD ceremony.

**Overrides in force**: stay on `main`, never branch, never commit; never edit CLAUDE.md / README.md / docs/dev.md; unresolved product decisions are RATIFIED-BY-DEFAULT in `clarifications-needed.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US5 from spec.md; Setup/Foundational/Polish carry no story label
- All paths are repo-relative from `/local-dev`

## Story priority map

- US1 (P1) — canonical coaching content · US2 (P1) — harness rehearses the real content
- US3 (P2) — consent first-run surface · US4 (P2) — grading that cannot be fooled · US5 (P2) — full matrix + exit gate

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the new directory trees this feature adds. No app code yet.

- [X] T001 Create the canonical content directory `distribution/shared/` (empty, tracked) per plan Project Structure — nothing else under `distribution/` (FR-020)
- [X] T002 [P] Create the repo-shape fixture tree `test/first-run/repo-fixtures/{kiro-specs,specs,claude-md,bare}/` with placeholder `.gitkeep` files (content authored in US5)
- [X] T003 [P] Create the grader fixtures placeholder note in `test/first-run/fixtures/` documenting the three new JSONL fixtures to be authored in US4 (no logic)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The one shared primitive multiple stories consume: parsing the client's structured stream into gradable prose + tool-call events (R1, RBD-2).

**⚠️ Blocks**: US2 (harness capture), US4 (event-based grading), US5 (cell grading). US1 and US3 do NOT depend on this phase and may proceed independently.

- [X] T004 Implement the structured-capture parser `test/first-run/capture.mjs`: parse `claude -p --output-format stream-json` JSONL into `{ prose, events }` where `events` is an ordered list of `{ tool, input, result }` tool-call records; export a helper to substring-scan the raw capture for a secret (used by the token-bytes assertion). Fail-closed contract: expose whether event data was present so callers can fail performable checks closed when it is absent (RBD-2).

**Checkpoint**: Capture parsing available to grader, harness, and matrix runner.

---

## Phase 3: User Story 1 - Canonical coaching content (Priority: P1) 🎯 MVP

**Goal**: Author the two canonical shared files that ARE the product's activation flow, restating the Agent Surface contract without forking it.

**Independent Test**: A structured review confirms every design-fixed element is present (entry states, four walkthrough steps in order, caveat, four failure-ladder rungs, five moves, the loop + byte-channel + token rules) and nothing contradicts `design/agent-surface-mcp.md`. Behavioral validation arrives via US2/US4/US5.

**Depends on**: nothing (independent of Phase 2).

- [X] T005 [US1] Author `distribution/shared/skill.md` — the when-to-use-Squire-Docs steering body: the standing loop (sync-before / read-at-start / write-back-after, FR-002), the byte-channel rule (bytes-outside-the-model over REST import/export, never retyped even after reading, FR-003), token handling (`~/.squire/token`, 0600, referenced not printed, never in transcript/echo/argv, FR-004). "Squire Docs" throughout, honest-confident voice (FR-006).
- [X] T006 [US1] Author `distribution/shared/onboard.md` — the `/squire:onboard` flow body: tool-presence-only entry detection (FR-007); the four walkthrough steps in order (expectation line before browser / `/mcp` native flow no `claude mcp add` / remote paste-back verbatim from Agent Surface / re-check-and-continue-silently, FR-008..011); command-availability caveat (FR-012); the four failure-ladder rungs and nothing else (FR-013); the five moves — connect / find-spec precedence `.kiro/specs`→`specs/`→`PLAN.md`|`docs/plan.md`→`CLAUDE.md` + starter-spec fallback / byte-faithful `import_markdown_file` sync with receipt / doc-URL payoff + editor framing / teach-the-loop (FR-014..017); re-run-prefers-update (FR-018). No invented auth path (008/009 lesson).
- [X] T007 [US1] Documented contract cross-check: verify `skill.md` and `onboard.md` agree with `design/agent-surface-mcp.md` on channel rule, token handling, connect guidance, and walkthrough steps — record the zero-contradiction result in the feature artifacts (FR-005, SC-006). Note the deferred signup-line as an M3 obligation, not a local divergence (ledger gap 5).

**Checkpoint**: US1 content authored and contract-clean; ready to be assembled (US2) and rehearsed (US5).

---

## Phase 4: User Story 2 - The harness rehearses the REAL content (Priority: P1)

**Goal**: A minimal assembler turns `distribution/shared/` into an installable bundle the 029 harness consumes via `--bundle`, guarded by an agreement check; the harness captures structured events.

**Independent Test**: Run the assembler, point the harness `--bundle` at its output, complete one rehearsal; verify the transcript shows real coaching (not stub markers), `distribution/shared/` is unmodified, and tampering with a generated file fails the agreement check.

**Depends on**: US1 (content to assemble); Phase 2 (capture parser).

- [X] T008 [P] [US2] Implement `test/first-run/assemble-bundle.mjs` per `contracts/bundle-assembly.md`: read `distribution/shared/{skill.md,onboard.md}`, emit an installable bundle (plugin.json name `squire` + "Squire Docs" copy, marketplace.json, `.mcp.json` with the production endpoint, `skills/squire/SKILL.md` ← skill.md, `commands/onboard.md` ← onboard.md) with do-not-hand-edit headers pointing at the source (FR-019). Never mutate `distribution/shared/`. No mirrors/manifests/registry/publish.mjs (FR-020, RBD-1).
- [X] T009 [P] [US2] Implement `test/first-run/check-bundle-agreement.mjs`: re-derive generated content from `distribution/shared/` and exit non-zero on any divergence, excluding the `.mcp.json` endpoint field (FR-021). Runnable standalone (standard suite) and as a harness precondition.
- [X] T010 [US2] Extend `test/first-run/rehearsal-harness.mjs` capture: switch the model leg to `--output-format stream-json` and route the raw capture through `capture.mjs` (T004) so grading sees tool-call events, not flat text (RBD-2). Preserve the existing throwaway-copy endpoint indirection and the source-not-mutated invariant.
- [X] T011 [US2] Switch the harness `--bundle` default to the assembled bundle and assemble (or run the agreement check) per run, so a `shared/` edit mid-iteration can never exercise stale content (FR-019, spec Edge Case). `--bundle <path>` still overrides (029 RBD-9).

**Checkpoint**: A rehearsal exercises the real content byte-identical to `distribution/shared/`, with structured capture — the bridge every grading/matrix story needs.

---

## Phase 5: User Story 4 - Grading that cannot be fooled (Priority: P2)

**Goal**: Close the 029 grader's false-PASS vectors — quote-vs-perform, incidental `/d/…`, prose-vs-event, and the silent-reconnect contradiction — and wire `--require-claude` into the gate that consumes rehearsals.

**Independent Test**: Grade a quote-only transcript, an incidental-`/d/…`-path transcript, and a genuine performing transcript → FAIL/FAIL/PASS respectively; force the matrix model leg to fail → non-zero exit.

**Depends on**: Phase 2 (capture parser). Independent of US1/US2/US3 (grades static fixtures). `--require-claude` wiring lands in US5's runner.

- [X] T012 [US4] Rework `test/first-run/grade-transcript.mjs` to accept `gradeTranscript(capture, { serverOrigin })` where `capture = { prose, events }`; grade performable items 5 (byte-channel sync) and 6 (doc-URL) from tool-call events, failing closed when event data is absent (FR-026, RBD-2). Keep prose items 1,2,3,7 on the prose stream. Update BOTH existing callers to the new signature: the harness (T010) and the module's own CLI entrypoint (parse the input file through `capture.mjs` and accept a `--server-origin` flag so quickstart step 3 works on JSONL fixtures). Retire or regenerate the two legacy plain-text fixtures (`fixtures/full-coaching-transcript.txt`, `fixtures/stub-transcript.txt`) so no caller passes a raw string.
- [X] T013 [US4] Anchor item 6 (doc-URL payoff): pass only when a delivered URL's origin equals `serverOrigin` AND a doc-creating/import tool-call event corroborates it; incidental `/d/…` paths and other-origin URLs FAIL (FR-025). Per `contracts/coaching-checklist.md`.
- [X] T014 [US4] Regrade item 4 (silent reconnect) behaviorally: after tool presence is (re-)established, require the flow proceed directly into find-the-spec with NO success-ceremony block; reconnection prose neither required nor penalized (FR-027, RBD-10, ledger gap 1).
- [X] T015 [US4] Re-check item 1's matcher against the authored expectation-line semantics; widen to a semantic match (fail-closed philosophy) if the authored wording drifts from the regex (ledger gap 7, FR-026).
- [X] T016 [P] [US4] Author grader regression fixtures in `test/first-run/fixtures/`: `quote-only-transcript.jsonl` (quotes contract text, performs nothing → items 5,6 FAIL), `incidental-docpath.jsonl` (an incidental `/d/…` path, no doc-creating event / wrong origin → item 6 FAIL), `genuine-performing.jsonl` (real sync + real doc URL on server origin → items 5,6 PASS). Include tool-call events in the stream-json shape (FR-028, SC-003).
- [X] T017 [US4] Wire the three fixtures into the standard suite as a deterministic grader test asserting FAIL/FAIL/PASS on the corresponding items (SC-003); ensure it runs with no model access.

**Checkpoint**: Zero known false-PASS vectors; the grader measures what the agent DID, and the silent-reconnect item matches the design's no-ceremony rule.

---

## Phase 6: User Story 3 - The consent page becomes a first-run surface (Priority: P2)

**Goal**: Reframe the unauthenticated consent page as the product's first impression — copy/presentation only, mechanics untouched.

**Independent Test**: Load the consent page unauthenticated and verify the four framing elements; complete the sign-in round-trip and confirm consent still receives its OAuth parameters; existing consent/auth tests stay green.

**Depends on**: nothing (fully independent — the only production-app change).

- [ ] T018 [US3] Edit `client/src/pages/AuthorizePage.jsx` unauthenticated branch (`!isAuthenticated`): replace "Sign in required / please sign in to authorize this application" with a "Continue with Google" primary action stating sign-in and account creation are the same click (FR-022), plus one line each for what Squire Docs is (the durable, attributed spec layer for agentic development), what the agent is asking to do, and that every agent edit is attributed and revertible (FR-023). Keep the existing `returnTo` link target and query carriage unchanged (FR-024). "Squire Docs" / honest-confident voice (FR-006).
- [ ] T019 [P] [US3] Adjust the scoped styles (e.g. `client/src/components/LoginPage.css` or an AuthorizePage-scoped rule) so the three one-liners + primary action fit common mobile viewports without pushing the action below the fold (spec Edge Case). Authenticated consent card styling unchanged (FR-024).
- [ ] T020 [P] [US3] Add `client/src/pages/__tests__/AuthorizePage.test.jsx` (Vitest) asserting the unauthenticated state renders all four first-run framing elements, and that the authenticated consent card path is unchanged (FR-024, SC-005).
- [ ] T021 [US3] Verify the M1 tier-1 backend tests stay green — `server/__tests__/auth-return-to.test.js`, `server/__tests__/onboarding.test.js`, `server/__tests__/integration/first-run.test.js` (returnTo round-trip, `agent_oauth` provenance stamping, welcome-doc skip) — confirming the change is copy-only (FR-024).

**Checkpoint**: A brand-new user's first impression is the tuned first-run framing; server mechanics proven unchanged.

---

## Phase 7: User Story 5 - The full sign-off matrix and the M2 exit gate (Priority: P2)

**Goal**: One command runs all 11 cells unattended in the pod, each judged against a per-cell profile, always enforcing `--require-claude`; then the recorded exit gate.

**Independent Test**: Run the matrix command end to end in the pod; verify one graded, profile-judged result per cell, a non-zero exit if any cell misses its profile or its model leg is incomplete, and archived transcripts for review.

**Depends on**: US1 (content), US2 (bundle + capture), US4 (hardened grader), Phase 2. This story composes the others and lands last.

### Harness cell-enabling extensions (FR-032)

- [ ] T022 [US5] Add an **unauthenticated mode** to `test/first-run/rehearsal-harness.mjs`: configure the client's MCP server (endpoint via the throwaway copy) with NO Authorization header and NO completed consent, so Squire Docs tools are genuinely absent and the walkthrough branch runs (spec gap 2, R3). No new endpoint.
- [ ] T023 [US5] Add a **token-fallback mode**: mint a real `sk_sqd_` token for the fresh synthetic user via existing token machinery, write it to the scratch `HOME`'s `~/.squire/token` (0600), configure client MCP auth from that file, no OAuth session (FR-032, RBD-6, R5).
- [ ] T024 [US5] Add **scripted user-simulator turns**: drive the session with successive user turns reporting an event ("I clicked Deny" / "I closed the tab before approving" / pasting a synthesized full localhost callback URL) and capture the agent's coached response (FR-032, RBD-5, R4).
- [ ] T025 [US5] Add **fixture-repo cwd**: copy the cell's `repo-fixtures/<shape>` to a temp dir and run the client with it as the working directory, keeping fixtures pristine (FR-032, RBD-7, R6).
- [ ] T026 [P] [US5] Author the four repo-shape fixtures under `test/first-run/repo-fixtures/`: `kiro-specs/` (`.kiro/specs/**` + README), `specs/` (`specs/**` + README, the known file the sync cells assert), `claude-md/` (`CLAUDE.md` + README), `bare/` (README, nothing spec-shaped) per `contracts/matrix-cell-profile.md` (RBD-7).

### Matrix runner + profiles (FR-030/031/033)

- [ ] T027 [P] [US5] Author `test/first-run/matrix-cells.mjs` — the 11 cell definitions with expected-outcome profiles (required / exempt / assertions) per `contracts/matrix-cell-profile.md` (RBD-4/11/12).
- [ ] T028 [US5] Implement `test/first-run/matrix-runner.mjs`: run the 11 cells **serially** (no concurrency — shared DB, constitution II), each invoking the harness in the cell's mode/fixture/turns, capturing a structured transcript, grading against the cell profile (passing `serverOrigin`), archiving transcript + grade; exit non-zero unless every cell matches its profile with its model leg completed (FR-030/031).
- [ ] T029 [US5] Wire `--require-claude` **always on** in the matrix runner: a cell whose model leg failed/was skipped fails the gate; with `ANTHROPIC_API_KEY` absent the runner refuses to run rather than skipping legs (FR-029, RBD-3) — this is the gate 029's promotion note assigned to M2.
- [ ] T030 [US5] Implement the existing-account-never-consented cell's server-side steps: faucet-premint the synthetic account before the client starts, and assert exactly one account exists for the identity after consent (find-or-create, no duplicate) (FR-033, RBD-12).
- [ ] T031 [US5] Implement the token-fallback cell's security assertion: substring-scan the full captured transcript for the token bytes and fail the cell if present (RBD-6), using the `capture.mjs` scan helper (T004).

**Checkpoint**: One command produces a graded, profile-judged, archived result per cell with a trustworthy exit status — half of M2's exit.

---

## Phase 8: Polish & Exit Gate (Cross-Cutting)

**Purpose**: Record the M3 hand-off and the twofold exit gate; validate the whole feature.

- [ ] T032 [P] Author `specs/030-plugin-logic/promotion-notes.md` — the M3 obligations record (FR-035): Agent Surface signup-line amendment at ship time; agents.md / documentation-site / landing-page updates; real per-channel manifests + mirror repos + `publish.mjs` + full drift CI test replacing the rehearsal assembly; harness default `--bundle` → `distribution/claude-plugin` when it exists.
- [ ] T033 Run `quickstart.md` steps 2–6 in the dev pod and confirm each expected outcome (assembler + agreement; grader FAIL/FAIL/PASS; single rehearsal on real content; full matrix; consent-page client test + tier-1 green).
- [ ] T034 Produce the exit-gate record (FR-034, SC-007): capture a clean full-matrix run (archived transcripts + grades) as gate part (a); prepare the sign-off record scaffold (date, scope=mechanics+tone, transcript references) for Sam's production self-test as gate part (b). M3 stays blocked until both are recorded — HITL by definition; do not proceed to publish anything.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2, T004)**: after Setup; blocks US2, US4, US5. Does NOT block US1 or US3.
- **US1 (Phase 3)**: independent — can start immediately after Setup.
- **US2 (Phase 4)**: after US1 (content to assemble) + Phase 2 (capture).
- **US4 (Phase 5)**: after Phase 2. The grader logic and regression fixtures (T012–T014, T016, T017) are independent of US1/US2/US3 (they grade static fixtures). The one exception is T015 (item-1 semantic matcher), which re-checks the matcher against US1's *authored* expectation-line wording and therefore needs T006 done first. `--require-claude` wiring completes in US5 (T029).
- **US3 (Phase 6)**: fully independent — can run in parallel with everything.
- **US5 (Phase 7)**: after US1 + US2 + US4 + Phase 2 — composes them; lands last.
- **Polish (Phase 8)**: after US5 (exit gate needs a clean matrix run).

### Within-story ordering

- US2: T008/T009 (assembler + agreement, parallel) → T010 (capture wiring) → T011 (default switch).
- US4: T012 → T013/T014/T015 (grader item logic) → T016 (fixtures) → T017 (suite wiring).
- US5: harness extensions T022–T026 → cell profiles T027 → runner T028 → T029/T030/T031.

### Parallel opportunities

- Setup: T002, T003 parallel.
- US3 (whole story) runs parallel to US1/US2/US4/US5 — different files, no shared deps.
- Within US2: T008 ∥ T009. Within US4: T016 ∥ (after T012–T015). Within US5: T026 ∥ T027 (fixtures ∥ cell defs); harness extensions T022–T025 touch the same harness file so are NOT mutually parallel.

---

## Parallel Example

```bash
# After Setup, three independent tracks can start at once:
Track A (US1): author distribution/shared/skill.md + onboard.md
Track B (US3): AuthorizePage first-run copy + client test  (fully independent)
Track C (Phase 2): capture.mjs  (unblocks US2/US4/US5)
```

---

## Implementation Strategy

### MVP (US1 + US2)

1. Setup → Phase 2 (capture) → US1 (content) → US2 (assemble + rehearse real content). At this point a rehearsal exercises the real coaching — the design's core M2 method is live, even before the grader is hardened.

### Incremental delivery

1. MVP (US1+US2) → real content rehearses.
2. US4 → grades cannot be fooled (deterministic fixtures green).
3. US3 → the one production surface a first-run user sees (independent, ship any time).
4. US5 → the full matrix + exit gate composes everything.
5. Polish → M3 obligations recorded; exit gate captured; Sam's HITL sign-off closes M2.

### Note on the exit gate

M2 is NOT done at code-complete: the exit is (a) a clean full-matrix run AND (b) Sam's production self-test sign-off on mechanics AND tone (FR-034). Nothing is published, and M3 does not begin, before that record exists (SC-007).

---

## Notes

- [P] = different files, no incomplete-task dependency. Harness-file tasks (T010, T011, T022–T025) serialize against each other.
- Backend-DB-touching activity (rehearsals, matrix cells) runs serially — never concurrent (constitution II).
- No commits (feature override); no edits to CLAUDE.md / README.md / docs/dev.md.
- The matrix runner is on-demand / pre-sign-off, not per-commit CI (RBD-3); deterministic pieces (grader fixtures, agreement check, consent client test) join the standard suites.
