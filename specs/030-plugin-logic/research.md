# Research: Plugin Logic (Plugin M2)

Phase 0 for `030-plugin-logic`. Resolves the technical unknowns the spec/ledger flagged (gaps 2/3, RBD-1/2/3/5/6/7). Product decisions already live in `clarifications-needed.md` (RBD-1..12); this file records the *technical* decisions the plan needs, each as Decision / Rationale / Alternatives.

## R1 — Structured transcript capture that carries tool-call events (spec gap 3, RBD-2)

**Decision**: Drive the model leg with `claude -p --output-format stream-json` (JSONL) instead of `--output-format text`, and parse the JSONL into (a) a prose transcript (assistant text deltas concatenated) and (b) an ordered list of tool-call events (tool name + input/params + result where present). The grader's performable items grade against the event list; prose items grade against the prose stream. If a rehearsal's capture yields zero parseable events where events are expected, the performable items fail closed (RBD-2) rather than falling back to prose.

**Rationale**: `--output-format text` collapses everything to a flat string with no tool boundaries, so "grade what the agent *did*" (029 promotion note) is impossible from it. `stream-json` is the client's own structured event stream and needs no bespoke instrumentation; it exposes `tool_use`/`tool_result` blocks that name the tool (`import_markdown_file`, `create_document`, `create_access_token`, `Bash` running a byte-channel `curl`) and carry their inputs. Failing closed keeps a capture regression from silently reopening the false-PASS hole.

**Alternatives considered**:
- *Claude Code hooks (PreToolUse/PostToolUse) writing an event log*: also viable and more decoupled from output format, but adds a hook-config surface to the scratch `CLAUDE_CONFIG_DIR` and a side-channel file to correlate; `stream-json` keeps capture in one stream the harness already owns. Kept as fallback if `stream-json` proves lossy for a needed event.
- *Keep `--output-format text`, regex tool names from prose*: rejected — it is exactly the prose-inference the promotion note forbids; a quoted tool name is indistinguishable from a called one.

**VERIFICATION (implement time, T004 / analyze LOW L1) — CONFIRMED, no pivot.** Probed the real client in the pod (claude v2.1.217) with `claude -p '<task using Bash>' --output-format stream-json --verbose --allowedTools Bash --dangerously-skip-permissions`. The JSONL stream carries tool-call events losslessly and structurally:
- `{type:'system',subtype:'init'}` — session init.
- `{type:'assistant',message:{content:[ {type:'thinking'} | {type:'tool_use',name,input,id} | {type:'text',text} ]}}` — the model's turns; `tool_use` blocks name the tool and carry its full `input` object.
- `{type:'user',message:{content:[ {type:'tool_result',tool_use_id,content,is_error} ]}}` — tool results, correlated to their call by `tool_use_id`.
- `{type:'result',subtype:'success'}` — terminal.

So `capture.mjs` parses events by pairing each `tool_use` with the `tool_result` sharing its `tool_use_id`, and concatenates `text` blocks for the prose stream. **Required flag note:** `stream-json` with `-p` REQUIRES `--verbose` (the client errors otherwise); the harness/matrix model leg must pass `--verbose`. The R1 hooks-based fallback is NOT needed and is not built.

## R2 — Anchoring the doc-URL payoff item to the rehearsal-server origin + a real tool call (FR-025)

**Decision**: The doc-URL item passes only when BOTH hold: (a) a delivered URL's origin equals the rehearsal server's origin (the harness already knows `SERVER`, e.g. `http://localhost:3001`, and passes it to the grader), AND (b) an observed tool-call event created/imported a doc (an `import_markdown_file` recipe run, a `create_document`, or the byte-channel `curl` import) — or equivalent server-side evidence (the doc exists for the synthetic user). A bare `/d/…` path with no matching origin and no corroborating event fails.

**Rationale**: The 029 grader's `/\/d\/[a-z0-9-]{6,}/` matches incidental paths and any origin, so a transcript that merely mentions a doc-shaped path passes. Requiring same-origin AND a doc-creating event closes both the incidental-path and wrong-origin vectors named in the promotion note and FR-025. Passing the server origin into the grader (new optional param) keeps the grader pure/testable while making the check real.

**Alternatives considered**:
- *Origin-only anchoring*: rejected — a transcript could print a correctly-origined but fabricated URL without ever creating a doc; the corroborating event is what proves performance.
- *Server-side existence query only*: usable as the "equivalent server-side evidence" branch, but the event-based path keeps the grader runnable against archived transcripts offline (regression fixtures need no live server).

## R3 — Unauthenticated harness mode: genuinely-absent tools so the walkthrough branch runs (spec gap 2, FR-032)

**Decision**: Add an unauthenticated mode to the harness that configures the client's MCP server (endpoint → dev server via the existing throwaway-copy indirection) but supplies NO `Authorization` header and completes NO consent — so Claude Code surfaces no Squire Docs tools, exactly the "no tools present" branch. The model leg then must exhibit the auth walkthrough coaching. In the pod the localhost OAuth callback naturally fails, so a non-interactive `/mcp` consent cannot complete mid-run; the cell grades the *coaching*, not a completed exchange (spec gap 4 — the exchange machinery is already proven by the tier-2 driver, and real client-native mid-session consent is Sam's prod self-test).

**Rationale**: 029's harness always pre-authorizes (mints a token out-of-band and hands it as a header), so tools are always present and the coaching branch — the heart of the flow — is never reached (spec gap 2). Removing the pre-auth header is the minimal change that makes the branch real, and it needs no new endpoint.

**Alternatives considered**:
- *Complete consent in-run via auto-approve mid-session*: rejected — Claude Code loads MCP config at startup and owns the `/mcp` consent UX; a non-interactive session can't drive it, and faking it would test the harness, not the coaching. The design deliberately splits real mid-session consent to Sam's prod walk.
- *A new "no-auth" dev endpoint*: rejected — no endpoint is needed; absence of a header IS the state (fewer gated surfaces, RBD-5 spirit).

## R4 — Scripted user-simulator turns for the failure-ladder cells (FR-032, RBD-5)

**Decision**: For declined-consent, abandoned-tab, and remote-paste-back cells, drive the session with a scripted sequence of user turns (the harness supplies successive prompts) reporting the event — "I clicked Deny", "I closed the tab before approving", or pasting a synthesized full callback URL (`http://localhost:…/callback?code=…&state=…`) — and grade the agent's coached response. Multi-turn driving uses the client's session-continuation (`--continue`/`--resume` against the scratch config dir) or a single prompt scripting the turn sequence, whichever the harness can drive non-interactively; the observable graded is the coaching text, not a state transition.

**Rationale**: These rungs grade coaching (the agent's response to a user-reported event), which lives entirely in the conversation — no new server endpoint or state machine is needed (RBD-5). M1's auto-approve already covers cases where consent must actually complete.

**Alternatives considered**:
- *New dev endpoints (`consent-decline`, `tab-abandon`)*: rejected per RBD-5 — every new dev endpoint is another gated surface; the coaching observable needs none.

## R5 — Headless token-fallback cell mechanics (FR-032, RBD-6)

**Decision**: Mint a real `sk_sqd_` token for the fresh synthetic user via the existing token machinery (the `create_access_token` claim flow or the faucet-session-authenticated mint path already used by the harness), write it to the scratch environment's `~/.squire/token` (scratch `HOME`, `0600`), and configure the client's MCP auth to read from that file — no OAuth session in the cell. Assertions: the flow skips the walkthrough and proceeds identically to the connected path, AND the token bytes never appear anywhere in the captured transcript (a substring scan of the full JSONL for the token value must find nothing).

**Rationale**: Uses only existing production token machinery (008/009 lesson: no bespoke auth) and stages exactly the design's rung state. The token-bytes-never-in-transcript assertion is the security invariant FR-004/RBD-6 require.

**Alternatives considered**:
- *Reuse the pre-authorized header path as "token fallback"*: rejected — that tests OAuth-delegation tokens via header, not the `~/.squire/token` file path the design's rung specifies; the file path is the thing under test.

## R6 — Repo-shape fixtures as the driven session's working directory (FR-032, RBD-7)

**Decision**: Ship four small fixture repos under `test/first-run/repo-fixtures/` — `kiro-specs/` (`.kiro/specs/**`), `specs/` (`specs/**`), `claude-md/` (`CLAUDE.md` only), `bare/` (nothing spec-shaped; README present, plus a README-less variant path for the fallback edge case). The harness copies the cell's fixture to a temp dir and runs the client with that temp dir as cwd. Happy-path/sync cells use the `specs/`-shaped (or `.kiro`) fixture so a real byte-channel sync of a known file is assertable. Fixtures stay pristine (temp copies per run).

**Rationale**: Running find-the-spec against the live app repo would make grades depend on this repo's contents and could sync junk docs (RBD-7). Deterministic fixture inputs make the precedence/candidate/starter-spec assertions checkable.

**Alternatives considered**:
- *Generate fixture trees on the fly in the runner*: workable but less legible than committed fixtures a human can inspect; committed fixtures double as documentation of the precedence order.

## R7 — Bundle assembly from `distribution/shared/` (FR-019/020/021, RBD-1)

**Decision**: `test/first-run/assemble-bundle.mjs` reads `distribution/shared/{skill.md,onboard.md}` and writes an installable bundle (reusing the 029 stub's manifest/`.mcp.json`/marketplace shape) with `skills/squire/SKILL.md` from `skill.md` and `commands/onboard.md` from `onboard.md`, each generated file carrying a do-not-hand-edit header pointing at `distribution/shared/`. `check-bundle-agreement.mjs` re-derives the generated content from `shared/` and fails if the on-disk bundle diverges (byte comparison of the content region, ignoring the endpoint field the harness templates). The harness `--bundle` default becomes the assembled bundle; the source `shared/` files are never mutated (endpoint indirection stays on the harness throwaway-copy mechanism, 029 FR-020).

**Rationale**: Smallest thing that makes rehearsals exercise the real canonical content while keeping `distribution/` free of M3 artifacts (no `publish.mjs`, no mirrors, no per-channel manifests). The parameterized `--bundle` path (029 RBD-9) was designed for exactly this swap.

**Alternatives considered**:
- *Build `distribution/publish.mjs` now*: rejected — smuggles M3 into M2 (FR-020, RBD-1).
- *Hand-copy `shared/` into the stub*: rejected — recreates the drift the generated-copies rule exists to prevent; the agreement check exists precisely so a hand-edited generated file fails.

## R8 — The matrix runner: gate semantics, serialization, `--require-claude` (FR-029/030/031, RBD-3/4/11)

**Decision**: `matrix-runner.mjs` runs the 11 cells serially (never concurrent — backend-DB-touching activity is serial, constitution II), each invoking the harness in the cell's mode against the cell's fixture, capturing a structured transcript, grading it against the cell's expected-outcome profile (required items / exempted items / cell-specific assertions), and archiving transcript + grade. It ALWAYS enforces `--require-claude` (a cell whose model leg failed or was skipped fails the gate) and refuses to run at all without model access (`ANTHROPIC_API_KEY` absent → hard exit, not skip). Exit is non-zero unless every cell matches its profile with its model leg completed. It is run on demand during iteration and as the pre-sign-off exit check — not per-commit CI (RBD-3).

**Rationale**: Honors the 029 obligation (no rehearsal counts while its model leg is broken) and the design's per-cell "clean" definition (RBD-4) without adding a flaky, costly per-commit CI job the no-ceremony principle rejects (RBD-3). Serial execution matches the shared-DB constraint.

**Alternatives considered**:
- *Blanket `--require-all` for every cell*: rejected — most failure-ladder cells cannot reach all seven items (RBD-4); profiles encode per-scenario reachability. `--require-all` stays correct for the full happy-path cells.
- *Retry-until-green per cell*: rejected for the exit run — the exit artifact is a single full-matrix pass; an intermittently-passing cell is a content defect to fix, not a flake to retry (RBD-11). Free re-runs are fine during iteration.

## R9 — Silent-reconnect item regraded behaviorally (FR-027, RBD-10, ledger gap 1)

**Decision**: Replace the 029 grader's item-4 prose regex (`/reconnect/ && /continue/`) with a behavioral check: after tool presence is (re-)established in the transcript, the flow proceeds directly into the find-the-spec step with no success-ceremony block (no congratulation/announcement between consent completion and the spec step). Prose mentioning reconnection is neither required nor penalized.

**Rationale**: The design's step 4 says "success needs no ceremony — the next thing the user sees is their spec syncing"; correctly-silent content would FAIL the old regex, forcing ceremony to pass (tail wagging the dog). The grader must measure the specified behavior, not its opposite. This is a defect in already-merged M1 code (ledger gap 1), fixed here.

**Alternatives considered**:
- *Leave item 4 as-is and author ceremony into the content to satisfy it*: rejected — violates the design's explicit no-ceremony rule.

## R10 — Item-1 matcher and the consent-page copy/round-trip reuse (ledger gap 7, FR-024)

**Decision**: As the real content is authored, re-check grader item 1's matcher (`/sign(ing)?-in creates … account/`) against the design's expectation-line semantics ("signing in with Google creates your account if you've never used Squire Docs") and widen to a semantic match if the authored wording drifts from the regex (same semantic-over-regex treatment as items 4/5/6), fail-closed philosophy per FR-026. The consent-page change is copy/presentation only: the unauthenticated `AuthorizePage` branch gains the "Continue with Google" action + three one-liners; the existing `returnTo` link, OAuth-parameter carriage, signup-provenance stamping (server, `agent_oauth`), and welcome-doc skip are reused untouched — verified by keeping the tier-1 backend tests green (`server/__tests__/auth-return-to.test.js`, `onboarding.test.js`, `integration/first-run.test.js`).

**Rationale**: The wording is authored at implement time (RBD-8) and iterated against the harness, so freezing item 1's regex now would pre-empt the loop; a semantic matcher tracks the authored line. The server behavior behind the consent page is M1-verified and must not change (FR-024) — the M2 change is purely the unauthenticated view's copy.

**Alternatives considered**:
- *Touch the server consent/returnTo path*: rejected — out of scope (no new auth machinery); the change is client copy only. Existing tests are the guardrail that proves mechanics unchanged.
