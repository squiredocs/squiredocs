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
 * walkthrough is coached with tools absent — items 1,3), then the harness
 * completes consent via auto-approve and phase B RE-RUNS /squire:onboard in a
 * FRESH authed client (tools present) — the content's own "reconnect, then re-run
 * onboard" instruction (design step 4). This is how find-spec + sync + payoff
 * (items 5,6,7) run in-pod.
 *
 * Item reachability is a per-cell PROFILE, never a global checklist weakening
 * (RBD-4): required items must pass; exempt items are unreachable in that scenario
 * and not graded; assertions are cell-specific checks beyond the seven.
 *
 * === Two documented reachability boundaries (validated live, RBD-4) ===
 * These two checklist items are NOT authentically reproducible in the unattended
 * non-interactive `claude -p` harness; each is validated where it IS reachable
 * plus Sam's interactive prod self-test (design gap-4 division of labor). Both are
 * still GRADED and reported (non-gating where exempt) for transparency — this is
 * documented classification, not silent weakening.
 *
 *  • Item 2 (bare authorize URL): in `/squire:onboard` the authorization URL is
 *    generated and shown by the Claude Code CLIENT's own `/mcp` login UI, never
 *    emitted by the agent — so a non-interactive agent has no URL to print. EXEMPT
 *    in every pod profile; verified in Sam's real interactive /mcp (exit part b).
 *  • Item 4 (single-session reconnect, "success needs no ceremony"): this is a
 *    SINGLE-SESSION behavior (after tools appear mid-session, continue straight to
 *    the spec with no celebration). The two-phase connect harness's phase B is a
 *    FRESH session, so the model naturally re-greets — an artifact of splitting one
 *    flow across two processes, not a content ceremony. Item 4 is REQUIRED (and
 *    passes live) in the genuinely single-session tools-present cells —
 *    already-connected and headless-token-fallback — and EXEMPT in the two-phase
 *    connect cells and the walkthrough-only cells (which never reconnect). Sam's
 *    prod self-test walks the real single-session reconnect.
 *
 * === shape-cell reachability ===
 *  • shape-kiro is a PRECEDENCE cell: with both .kiro/specs and specs/ present the
 *    model correctly OFFERS the best candidate and awaits confirmation rather than
 *    silently syncing (design: "offer, don't pick") — so sync items 5,6,7 are
 *    unreachable there. Required [1,3] + the ".kiro offered first" assertion.
 *  • shape-claude-md / shape-bare are CANDIDATE-SELECTION cells (L4): they prove
 *    the candidate/starter-spec OFFER, not a full sync (fresh-happy + shape-specs
 *    already prove sync+payoff). They use the connect flow so find-spec actually
 *    runs and the offer is real; items 5,6,7 are exempt.
 *  • shape-specs is the single-candidate happy SYNC (items 5,6,7 required).
 */

// --- assertion helpers ------------------------------------------------------

const proseAssertion = (name, re) => ({
  name,
  check: ({ capture }) => ({ pass: re.test(capture.prose || ''), detail: re.source }),
});

const noImprovisedAuth = {
  name: 'no improvised / non-standard auth path',
  check: ({ capture }) => {
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
      required: [1, 3, 5, 6, 7],
      exempt: [2, 4],
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
      required: [1, 3, 5, 6, 7],
      exempt: [2, 4],
      assertions: [
        {
          name: 'exactly one account for the identity after consent (find-or-create, no duplicate)',
          check: ({ accountCount }) => ({ pass: accountCount === 1, detail: `accountCount=${accountCount}` }),
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
      exempt: [2, 4, 5, 6, 7],
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
      exempt: [2, 4, 5, 6, 7],
      assertions: [
        proseAssertion('consent URL is re-openable', /re[- ]?open|open (?:it|the consent)|the consent (?:url|link|page)|retry/i),
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
    // Prime the remote/sandboxed context so the model reliably gives the remote
    // OAuth-walkthrough guidance (bare URL + expected localhost error + paste-back)
    // rather than deferring to an interactive session.
    prompt: "Run the /squire:onboard command to onboard me to Squire Docs. Important context: I'm working over SSH on a headless remote server — there is no browser on this machine and localhost callbacks cannot reach it. Then stop.",
    userTurns: ['http://localhost:8765/callback?code=abc123def456&state=deadbeefcafe'],
    profile: {
      required: [3],
      exempt: [2, 4, 5, 6, 7],
      assertions: [
        proseAssertion('pre-warning about the expected callback error', /localhost[^.\n]*(error|expected|fail|can'?t|cannot|unreachable)/i),
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
    name: 'repo shape: .kiro/specs (precedence)',
    mode: 'unauthenticated',
    connect: true,
    fixture: 'kiro-specs',
    profile: {
      required: [1, 3],
      exempt: [2, 4, 5, 6, 7],
      assertions: [
        proseAssertion('.kiro/specs candidate offered first (precedence over specs/)', /\.kiro\/specs/i),
      ],
    },
  },
  {
    id: 'shape-specs',
    name: 'repo shape: specs/ (single-candidate sync)',
    mode: 'unauthenticated',
    connect: true,
    fixture: 'specs',
    profile: {
      required: [1, 3, 5, 6, 7],
      exempt: [2, 4],
      assertions: [
        proseAssertion('specs/ candidate offered', /\bspecs\//i),
      ],
    },
  },
  {
    id: 'shape-claude-md',
    name: 'repo shape: CLAUDE.md (candidate selection)',
    mode: 'unauthenticated',
    connect: true,
    fixture: 'claude-md',
    profile: {
      required: [1, 3],
      exempt: [2, 4, 5, 6, 7],
      assertions: [
        proseAssertion('CLAUDE.md offered as the candidate (lowest precedence before starter-spec)', /CLAUDE\.md/),
      ],
    },
  },
  {
    id: 'shape-bare',
    name: 'repo shape: nothing spec-shaped (starter-spec offer)',
    mode: 'unauthenticated',
    connect: true,
    fixture: 'bare',
    profile: {
      required: [1, 3],
      exempt: [2, 4, 5, 6, 7],
      assertions: [
        proseAssertion(
          'starter-spec offer drawn from README + repo structure',
          /starter spec|draft[^.\n]{0,30}spec|write[^.\n]{0,20}spec|create[^.\n]{0,20}spec|scaffold[^.\n]{0,20}spec|spec[^.\n]{0,30}(from|based on)[^.\n]{0,20}(readme|repo)/i,
        ),
      ],
    },
  },
];

export default CELLS;
