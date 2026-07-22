/**
 * Feature 030 US5 (T027, FR-031, RBD-4/11/12) — the 11 sign-off-matrix cells and
 * their expected-outcome profiles, per contracts/matrix-cell-profile.md.
 *
 * Each cell:
 *   { id, name, mode, connect?, fixture, setup?, userTurns?, prompt?,
 *     profile: { required:[itemIds], exempt:[itemIds], assertions:[{name, check}] } }
 *
 * `mode` stages the client's auth (harness):
 *   - 'unauthenticated'  : no header, no consent → Squire Docs tools ABSENT (walkthrough branch).
 *   - 'pre-authorized'   : Bearer header from a completed auto-approve → tools PRESENT.
 *   - 'token-fallback'   : sk_sqd_ token at scratch ~/.squire/token → tools PRESENT.
 *
 * `connect: true` runs the two-phase connect flow: phase A unauthenticated (the
 * walkthrough is coached with tools absent), then the harness completes consent
 * via auto-approve and RESUMES the session with an authed config so the tools
 * appear — modelling "after consent the client reloads the authorized server"
 * (design step 4). This is the only way a single unattended run exhibits BOTH
 * the walkthrough (items 1,2,3) AND a real sync/payoff (items 5,6) — a
 * non-interactive `/mcp` consent cannot complete mid-process (R3, spec gap 4).
 *
 * Item reachability is a per-cell PROFILE, never a global checklist weakening
 * (RBD-4): required items must pass; exempt items are unreachable in that
 * scenario and not graded; assertions are cell-specific checks beyond the seven.
 *
 * === L4 decision (shape-claude-md item 5/6 requiredness) ===
 * shape-claude-md is a CANDIDATE-SELECTION cell: its distinct job is proving
 * CLAUDE.md is offered at the correct (lowest) precedence, NOT re-proving a full
 * sync (fresh-happy and shape-specs already prove sync + payoff). It therefore
 * does NOT drive a full sync, so items 5 (byte-channel sync), 6 (doc URL) and 7
 * (loop taught, which follows the payoff) are EXEMPT; required = [1,2,3,4] plus
 * the "CLAUDE.md offered" assertion. This resolves the contract's asterisk
 * explicitly (contracts/matrix-cell-profile.md, RBD-4).
 */

// --- assertion helpers ------------------------------------------------------

const proseAssertion = (name, re) => ({
  name,
  check: ({ capture }) => ({ pass: re.test(capture.prose || ''), detail: re.source }),
});

const noImprovisedAuth = {
  name: 'no improvised / non-standard auth path',
  check: ({ capture }) => {
    // FAIL if the coaching invents anything outside standard OAuth (/mcp) or the
    // sk_sqd_ token fallback. Heuristic: flag device-code / manual-token-paste
    // inventions; PASS otherwise.
    const p = capture.prose || '';
    const invented = /(device[- ]?code flow|enter this code at|paste your (?:api )?token (?:here|into (?:chat|the conversation))|activation code)/i.test(p);
    return { pass: !invented, detail: invented ? 'invented-auth-language detected' : 'standard OAuth / sk_sqd_ only' };
  },
};

const offersRetryViaMcp = proseAssertion('offers retry via /mcp', /\/mcp\b/i);

// --- the 11 cells -----------------------------------------------------------

export const CELLS = [
  {
    id: 'fresh-happy',
    name: 'fresh user — happy path',
    mode: 'unauthenticated',
    connect: true,
    fixture: 'specs',
    profile: {
      required: [1, 2, 3, 4, 5, 6, 7],
      exempt: [],
      assertions: [
        {
          name: 'real byte-channel sync + real doc URL on server origin',
          check: ({ grade }) => {
            const i = (id) => grade.items.find((x) => x.id === id)?.pass;
            return { pass: !!i(5) && !!i(6), detail: `item5=${i(5)} item6=${i(6)}` };
          },
        },
      ],
    },
  },
  {
    id: 'existing-never-consented',
    name: 'existing account, never consented',
    mode: 'unauthenticated',
    connect: true,
    fixture: 'specs',
    setup: 'faucet-premint',
    profile: {
      required: [1, 2, 3, 4, 5, 6, 7],
      exempt: [],
      assertions: [
        {
          name: 'exactly one account for the identity after consent (find-or-create, no duplicate)',
          check: ({ accountCount }) => ({
            pass: accountCount === 1,
            detail: `accountCount=${accountCount}`,
          }),
        },
      ],
    },
  },
  {
    id: 'already-connected',
    name: 'already connected — straight to sync',
    mode: 'pre-authorized',
    fixture: 'specs',
    profile: {
      required: [4, 5, 6, 7],
      exempt: [1, 2, 3],
      assertions: [
        {
          name: 'walkthrough skipped (tools present at start) — no bare authorize URL emitted',
          check: ({ grade }) => {
            const item2 = grade.items.find((x) => x.id === 2)?.pass;
            return { pass: item2 === false, detail: `no-walkthrough (item2=${item2})` };
          },
        },
      ],
    },
  },
  {
    id: 'declined-consent',
    name: 'declined consent',
    mode: 'unauthenticated',
    fixture: 'specs',
    userTurns: ['I clicked Deny on the consent screen.'],
    profile: {
      required: [1],
      exempt: [5, 6, 7],
      assertions: [
        proseAssertion('explains what the access was for', /(create|sync)[^.\n]*doc|access (?:was |is )?for|so (?:i|the agent) can/i),
        offersRetryViaMcp,
        noImprovisedAuth,
      ],
    },
  },
  {
    id: 'abandoned-tab',
    name: 'abandoned tab',
    mode: 'unauthenticated',
    fixture: 'specs',
    userTurns: ['I signed in but closed the browser tab before approving.'],
    profile: {
      required: [1],
      exempt: [5, 6, 7],
      assertions: [
        proseAssertion('consent URL is re-openable', /re[- ]?open|open (?:it |the )?again|the consent (?:url|link)/i),
        offersRetryViaMcp,
        noImprovisedAuth,
      ],
    },
  },
  {
    id: 'remote-paste-back',
    name: 'remote paste-back',
    mode: 'unauthenticated',
    fixture: 'specs',
    // A synthesized full localhost callback URL, pasted back as the user's turn.
    userTurns: ['http://localhost:8765/callback?code=abc123def456&state=deadbeefcafe'],
    profile: {
      required: [2, 3],
      exempt: [5, 6, 7],
      assertions: [
        proseAssertion('pre-warning about the expected callback error', /localhost[^.\n]*(error|expected|fail)/i),
        proseAssertion('paste-back handled', /paste|callback url/i),
        noImprovisedAuth,
      ],
    },
  },
  {
    id: 'headless-token-fallback',
    name: 'headless token fallback',
    mode: 'token-fallback',
    fixture: 'specs',
    profile: {
      required: [4, 5, 6, 7],
      exempt: [1, 2, 3],
      assertions: [
        {
          name: 'proceeds identically to the connected path (walkthrough skipped)',
          check: ({ grade }) => {
            const item2 = grade.items.find((x) => x.id === 2)?.pass;
            return { pass: item2 === false, detail: `no-walkthrough (item2=${item2})` };
          },
        },
        {
          name: 'token bytes NEVER appear in the transcript (RBD-6)',
          check: ({ tokenLeaked }) => ({ pass: tokenLeaked === false, detail: `tokenLeaked=${tokenLeaked}` }),
        },
      ],
    },
  },
  {
    id: 'shape-kiro',
    name: 'repo shape: .kiro/specs',
    mode: 'unauthenticated',
    connect: true,
    fixture: 'kiro-specs',
    profile: {
      required: [1, 2, 3, 4, 5, 6, 7],
      exempt: [],
      assertions: [
        proseAssertion('.kiro/specs candidate offered first (precedence)', /\.kiro\/specs/i),
      ],
    },
  },
  {
    id: 'shape-specs',
    name: 'repo shape: specs/',
    mode: 'unauthenticated',
    connect: true,
    fixture: 'specs',
    profile: {
      required: [1, 2, 3, 4, 5, 6, 7],
      exempt: [],
      assertions: [
        proseAssertion('specs/ candidate offered', /\bspecs\//i),
      ],
    },
  },
  {
    id: 'shape-claude-md',
    name: 'repo shape: CLAUDE.md (candidate selection)',
    mode: 'unauthenticated',
    fixture: 'claude-md',
    // L4: candidate-selection cell — does NOT drive a full sync (5,6,7 exempt).
    profile: {
      required: [1, 2, 3, 4],
      exempt: [5, 6, 7],
      assertions: [
        proseAssertion('CLAUDE.md offered as the candidate (lowest precedence before starter-spec)', /CLAUDE\.md/),
      ],
    },
  },
  {
    id: 'shape-bare',
    name: 'repo shape: nothing spec-shaped',
    mode: 'unauthenticated',
    fixture: 'bare',
    profile: {
      required: [1, 2, 3, 4],
      exempt: [5, 6, 7],
      assertions: [
        proseAssertion('starter-spec offer drawn from README + repo structure', /starter spec|draft (?:a )?spec|from (?:your |the )?readme/i),
      ],
    },
  },
];

export default CELLS;
