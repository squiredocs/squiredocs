# Contract: Matrix cell + expected-outcome profile

Schema for a sign-off-matrix cell and the 11 cells the runner (`test/first-run/matrix-runner.mjs`) executes serially (FR-030..033, RBD-4/11). Cell definitions live in `test/first-run/matrix-cells.mjs`.

## Cell schema

```
{
  id: string,                 // stable cell id
  name: string,               // human label
  mode: 'unauthenticated' | 'pre-authorized' | 'token-fallback',
  fixture: string,            // repo-fixtures/<shape> used as the driven cwd
  setup?: 'faucet-premint',   // optional pre-driver server-side setup
  userTurns?: string[],       // scripted user-simulator turns (declined/abandoned/paste-back)
  profile: {
    required: number[],       // checklist item ids that MUST pass
    exempt: number[],         // items unreachable in this scenario (not graded)
    assertions: string[],     // cell-specific checks beyond the checklist
  }
}
```

## The 11 cells

| id | mode | fixture | setup / userTurns | required items | exempt items | cell-specific assertions |
|---|---|---|---|---|---|---|
| fresh-happy | unauthenticated | specs/ | — | 1,2,3,4,5,6,7 | — | real byte-channel sync + real doc URL on dev-server origin |
| existing-never-consented | unauthenticated | specs/ | faucet-premint | 1,2,3,4,5,6,7 | — | exactly one account for identity after consent (no duplicate, FR-033/RBD-12); coaching identical to fresh |
| already-connected | pre-authorized | specs/ | — | 4,5,6,7 | 1,2,3 | walkthrough skipped; straight to spec sync (tools present at start) |
| declined-consent | unauthenticated | specs/ | userTurns: ["I clicked Deny"] | 1 + rung coaching | 5,6,7 | explains what access was for; offers retry via `/mcp`; no improvised auth |
| abandoned-tab | unauthenticated | specs/ | userTurns: ["I closed the tab before approving"] | 1 + rung coaching | 5,6,7 | consent URL re-openable; retry via `/mcp`; no improvised auth |
| remote-paste-back | unauthenticated | specs/ | userTurns: ["<full localhost callback URL>"] | 2,3 + rung coaching | 5,6,7 | bare URL on its own line; pre-warning re expected callback error; paste-back handled |
| headless-token-fallback | token-fallback | specs/ | — | 4,5,6,7 | 1,2,3 | proceeds identically to connected path; **token bytes never in transcript** (RBD-6) |
| shape-kiro | unauthenticated | kiro-specs/ | — | 1,2,3,4,5,6,7 | — | `.kiro/specs` candidate offered first (precedence) |
| shape-specs | unauthenticated | specs/ | — | 1,2,3,4,5,6,7 | — | `specs/` candidate offered when no `.kiro` |
| shape-claude-md | unauthenticated | claude-md/ | — | 1,2,3,4,6,7 | 5* | `CLAUDE.md` offered as candidate (lowest precedence before starter-spec) |
| shape-bare | unauthenticated | bare/ | — | 1,2,3,4 | 5,6,7 | starter-spec offer drawn from README + repo structure when nothing spec-shaped |

\* shape-claude-md: if the cell drives a full sync of `CLAUDE.md`, item 5/6 are required; if it only asserts candidate selection, they are exempt. The cell definition fixes which — the runner grades per the committed profile.

## Runner semantics (FR-029/030, RBD-3/11)

- Cells run **serially** (shared DB; no concurrency — constitution II, spec Edge Cases).
- **Always `--require-claude`**: a cell whose model leg failed/was skipped fails the gate; missing model access (`ANTHROPIC_API_KEY` absent) → the runner refuses to run rather than skipping legs.
- Each cell: run harness in `mode` against `fixture` (+ `setup`/`userTurns`), capture structured transcript, grade against `profile`, archive transcript + grade.
- Exit non-zero unless every cell matches its profile with its model leg completed.
- "Clean matrix" (exit artifact, SC-002) = one full-matrix run where all cells match; intermittently-passing cells are content defects to fix, not flakes to retry (RBD-11). Free re-runs during iteration.
