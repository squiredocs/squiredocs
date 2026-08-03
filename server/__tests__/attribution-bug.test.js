/**
 * The historical misattribution bug: a human's edits credited to an AI agent.
 *
 * WHAT WENT WRONG. Attribution used to be inferred from awareness. A connection
 * captured `connectionClientId` from the FIRST awareness message it saw — but an
 * awareness message can be a broadcast ABOUT other clients, not FROM this one.
 * So when an agent connected first and announced `isAgent: true`, the next human
 * connection captured the agent's clientId as its own, and every edit that human
 * made was recorded under the agent's name.
 *
 * HOW IT WAS FIXED. Agent tokens already carry `isAgent` and `agentName`, so the
 * identity is read from the AUTHENTICATED PRINCIPAL at connection time and
 * awareness-based detection was deleted outright. That derivation now lives in
 * `identityFromPrincipal` (server/agent-identity.js, feature 043 X2); that
 * production uses it rather than a private copy is pinned structurally by
 * server/__tests__/collab-extraction-guard.test.js (G4a/G4b).
 *
 * ── Why this file shrank (feature 043, FR-002/SC-001) ───────────────────────
 * It used to contain two tests whose entire body was a comment block proposing
 * a fix, followed by a tautology asserting that true is true. They said nothing about the
 * server; they passed before the bug was fixed and would pass again if it came
 * back. A test that cannot fail is worse than no test, because it reports
 * coverage that does not exist — and this was the flagship scenario of the
 * product's attribution promise. Both blocks are gone, along with the locally
 * re-declared y-websocket protocol constants they needed (a fourth copy of
 * numbers `server/ws-edit-gate.js` already exports) and the frame helpers that
 * used them.
 *
 * ── What still owes coverage ────────────────────────────────────────────────
 * The end-to-end version of this scenario — two authenticated clients, agent
 * first, human second, both editing, every persisted row's identity asserted —
 * is specified as feature 043 US1/FR-001 and is NOT yet implemented. It needs
 * the bindState update listener to be importable (extraction X1), which was
 * stopped and reported rather than forced: X1 collides with feature 041's
 * structural pins in server/__tests__/bindstate-failure.test.js, and editing
 * another feature's shipped guard is outside this feature's extraction budget
 * (ledger D9). See specs/043-version-history-test-hardening/promotion-notes.md.
 * The tests below are honest about their scope: the token claims the fix reads,
 * and the derivation it installed. Nothing here claims to cover the wire.
 */
const jwt = require('jsonwebtoken');
const { identityFromPrincipal } = require('../agent-identity');

const TEST_JWT_SECRET = 'test-jwt-secret-for-testing-only';

/** A test JWT shaped like the agent tokens the fix reads. */
function createTestToken(userId, options = {}) {
  const payload = {
    userId,
    email: options.email || `${userId}@test.com`,
    name: options.name || `User ${userId}`,
    isAgent: options.isAgent || false,
    agentName: options.agentName || null,
  };

  return jwt.sign(payload, TEST_JWT_SECRET, {
    expiresIn: '1h',
    issuer: 'collab-test',
  });
}

describe('token-based agent detection: the claims the fix reads', () => {
  test('agent tokens carry isAgent and agentName', () => {
    const decoded = jwt.decode(createTestToken('user-123', {
      isAgent: true,
      agentName: 'Claude Test Agent',
    }));

    expect(decoded.isAgent).toBe(true);
    expect(decoded.agentName).toBe('Claude Test Agent');
  });

  test('human tokens carry isAgent: false and no agent name', () => {
    const decoded = jwt.decode(createTestToken('user-456', { isAgent: false }));

    expect(decoded.isAgent).toBe(false);
    expect(decoded.agentName).toBe(null);
  });
});

describe('the derivation the bug fix installed', () => {
  // These drive the REAL production derivation, so reintroducing
  // awareness-based detection — or mishandling a non-agent principal — fails
  // here instead of passing a tautology.

  test('an agent principal is recorded under the agent name', () => {
    const principal = jwt.decode(createTestToken('user-123', {
      isAgent: true,
      agentName: 'Claude Test Agent',
    }));

    expect(identityFromPrincipal(principal)).toEqual({
      userId: 'user-123',
      agentName: 'Claude Test Agent',
    });
  });

  test('a human principal is recorded with NO agent name — the bug, inverted', () => {
    const principal = jwt.decode(createTestToken('user-456', { isAgent: false }));

    // The exact assertion the original bug would have failed: the human keeps
    // their own id and picks up no agent name from anywhere.
    expect(identityFromPrincipal(principal)).toEqual({
      userId: 'user-456',
      agentName: null,
    });
  });

  test('a principal carrying an agentName but not isAgent is still a human', () => {
    // Being an agent is the TOKEN'S claim, not the presence of a name field.
    // The awareness-era code effectively decided this the other way round.
    expect(identityFromPrincipal({ userId: 'u1', agentName: 'Impostor' }))
      .toEqual({ userId: 'u1', agentName: null });
  });

  test('identity comes from the principal alone — connection order cannot reach it', () => {
    const agent = jwt.decode(createTestToken('agent-user', { isAgent: true, agentName: 'A' }));
    const human = jwt.decode(createTestToken('human-user', { isAgent: false }));

    // Derive in both orders. The old code path made the SECOND connection
    // inherit the FIRST one's identity; a pure function of the principal cannot.
    const agentFirst = [identityFromPrincipal(agent), identityFromPrincipal(human)];
    const humanFirst = [identityFromPrincipal(human), identityFromPrincipal(agent)];

    expect(agentFirst[1]).toEqual({ userId: 'human-user', agentName: null });
    expect(humanFirst[0]).toEqual({ userId: 'human-user', agentName: null });
    expect(agentFirst[0]).toEqual(humanFirst[1]);
  });
});
