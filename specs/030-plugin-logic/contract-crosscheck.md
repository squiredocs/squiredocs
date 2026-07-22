# Contract cross-check: shared content vs. the Agent Surface (MCP) doc

**Task T007 · FR-005 · SC-006 · design principle 4** ("the plugin restates the agents.md contract; it never forks it").

Cross-checks `distribution/shared/skill.md` and `distribution/shared/onboard.md` against `design/agent-surface-mcp.md` (the front-door contract owner) on the four load-bearing axes plus the walkthrough. **Result: zero contradictions.** The one place the content says something the Agent Surface doc does not yet say — the signup line — is a deferred M3 amendment obligation the design explicitly schedules, not a local divergence (ledger gap 5).

| Axis | Agent Surface doc says | Shared content says | Verdict |
|---|---|---|---|
| **Channel rule** | "content that already exists as bytes outside the model travels the byte channel (REST import/export); model context only carries content the model itself creates or transforms" + create_document redirect "even if you have already read the file, the file remains the source of truth — use the byte channel" | skill.md: bytes-outside-the-model move over the REST byte channel, not tool parameters; "This holds even after you have read the file." onboard.md Move 3: never retype, even after reading. | **Agree** |
| **import_markdown_file** | 019 amendment: takes NO content, returns a ready-to-run recipe (token claim + curl import + receipt write-back); `frontmatter=true` → born-syncable | skill.md + onboard.md Move 3: `import_markdown_file` with `frontmatter: true` returns a recipe (claim token + import over REST + receipt write-back); run it; never `create_document({ markdown })` | **Agree** |
| **REST export** | `GET /api/docs/:docId/export?format=markdown`; pairs with `list_documents` `updatedSince` + per-doc clock | skill.md: identical endpoint + `list_documents` `updatedSince` for incremental pulls | **Agree** |
| **Token handling** | canonical `~/.squire/token`, `0600`; referenced `$(cat ~/.squire/token)`, never printed/echoed/retyped; argv leaks into history/process lists; `create_access_token` one-shot claim writes bytes straight to disk, never in context | skill.md: same file, same `0600`, same `$(cat …)` reference, same never-print/echo/argv rule, same `create_access_token` one-shot-claim-to-disk | **Agree** |
| **Connect guidance** | in-session caveat: a non-plugin agent must not run `claude mcp add` itself; `/mcp` inside the (re)started session confirms and finishes login. API-token fallback = `sk_sqd_` from Settings → AI Agent Access | onboard.md Move 1 step 2: run `/mcp`, pick `squire`, complete browser consent; "The plugin's server entry is already registered — do not run `claude mcp add`." | **Agree** — the plugin ships `.mcp.json` pre-registered, so "no `claude mcp add`" is the plugin-context application of the same contract (design: the plugin removes the `claude mcp add` failure mode), not a fork. |
| **OAuth walkthrough (remote/sandboxed)** | (1) authorization URL bare on its own line — no list markup, quotes, trailing punctuation; (2) before opening, explain the expected `localhost` callback error — approval still succeeded; (3) copy the FULL callback URL and paste it back, nothing else needed | onboard.md Move 1 step 3: verbatim on all three points | **Agree** (verbatim) |
| **No invented auth path** | 008/009 rolled back; agent auth is standard OAuth + `sk_sqd_` tokens only; "agents route around bespoke auth flows" | onboard.md failure ladder: "never improvise or invent an auth path … standard OAuth or an `sk_sqd_` token; agents route around bespoke flows, so there are no others" | **Agree** |

## The one addition — the signup line (deferred, not a divergence)

onboard.md Move 1 step 1 says: "if they have never used Squire Docs that same click creates their account — there is no separate signup step." The Agent Surface doc does **not** yet carry this line. This is by design: the plugin-marketplace design states the Agent Surface doc "gains the signup line ('signing in with Google creates the account if none exists') when this ships" — i.e. at M3. Until then the doc is **silent** on it, not opposed, so restating the find-or-create behavior in the onboard content contradicts nothing. Recorded as an M3 obligation in `promotion-notes.md` (FR-035) and clarifications ledger gap 5; M3 must land the amendment in the Squire doc (never as hand-edited export drift).

## Design-fixed elements present (structured review, US1 Independent Test)

- Entry-state detection by tool presence only, no probe call, no no-account/never-consented distinction — onboard.md Move 1. ✓
- Four walkthrough steps in order (expectation+signup line before browser → native `/mcp`, no `claude mcp add` → remote paste-back verbatim → re-check + continue silently, no ceremony) — onboard.md Move 1. ✓
- Command-availability caveat — onboard.md Move 1. ✓
- Failure ladder, all four rungs and nothing else — onboard.md. ✓
- Five moves (connect / find-spec precedence `.kiro/specs`→`specs/`→`PLAN.md`|`docs/plan.md`→`CLAUDE.md` + starter-spec fallback / byte-faithful sync + receipt / doc-URL payoff + editor framing / teach-the-loop) — onboard.md Moves 1–5. ✓
- Re-run-prefers-update — onboard.md "Re-running onboard". ✓
- Standing loop + byte-channel rule + token rule — skill.md. ✓
- Product name "Squire Docs" throughout (no bare "Squire" as product), honest-confident voice. ✓
