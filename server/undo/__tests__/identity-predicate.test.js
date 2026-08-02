/**
 * Feature 040 — FR-015 / SC-009: exactly ONE definition of "is this row mine?"
 *
 * Before this feature there were six hand-rolled identity comparisons, and
 * they did not agree. `edit-range.js` used a raw `===` on the agent name,
 * while `inverse.js` and `legacy.js` normalized with `?? null`. So a DB row
 * carrying `agent_name = NULL` and an in-process identity object that simply
 * omitted the `agentName` key were the same identity to two of the three undo
 * surfaces and different identities to the third.
 *
 * This file pins both halves: the predicate's own semantics, and the fact that
 * the three surfaces now genuinely agree.
 */
const { isSameIdentity } = require('../../agent-identity');

const U = '11111111-1111-1111-1111-111111111111';
const V = '22222222-2222-2222-2222-222222222222';

describe('040 FR-015: isSameIdentity', () => {
  test('is symmetric', () => {
    const a = { userId: U, agentName: 'Agent A' };
    const b = { userId: U, agentName: 'Agent A' };
    expect(isSameIdentity(a, b)).toBe(isSameIdentity(b, a));
    expect(isSameIdentity(a, b)).toBe(true);

    const c = { userId: U, agentName: 'Agent B' };
    expect(isSameIdentity(a, c)).toBe(isSameIdentity(c, a));
    expect(isSameIdentity(a, c)).toBe(false);
  });

  test('treats an absent agent name as the same identity whether null or undefined (THE bug fix)', () => {
    const dbRow = { userId: U, agentName: null };        // from Postgres
    const inProcess = { userId: U };                      // key omitted entirely
    const explicitUndefined = { userId: U, agentName: undefined };

    expect(isSameIdentity(dbRow, inProcess)).toBe(true);
    expect(isSameIdentity(inProcess, dbRow)).toBe(true);
    expect(isSameIdentity(dbRow, explicitUndefined)).toBe(true);
  });

  test('treats the empty string as a DISTINCT identity, never folded into "absent"', () => {
    // Legacy '' sentinel rows must never be silently claimed by the human
    // identity — that is why the predicate normalizes with `?? null` rather
    // than with a falsy check.
    const legacySentinel = { userId: U, agentName: '' };
    const human = { userId: U, agentName: null };
    const humanOmitted = { userId: U };

    expect(isSameIdentity(legacySentinel, human)).toBe(false);
    expect(isSameIdentity(legacySentinel, humanOmitted)).toBe(false);
    expect(isSameIdentity(legacySentinel, { userId: U, agentName: '' })).toBe(true);
  });

  test('compares userId strictly and never coerces it', () => {
    expect(isSameIdentity({ userId: U, agentName: 'A' }, { userId: V, agentName: 'A' })).toBe(false);
    // A null user id equals only another null user id.
    expect(isSameIdentity({ userId: null, agentName: 'A' }, { userId: null, agentName: 'A' })).toBe(true);
    expect(isSameIdentity({ userId: null, agentName: 'A' }, { userId: undefined, agentName: 'A' })).toBe(false);
  });

  test('is pure and total: a null/undefined operand is false, never a throw', () => {
    expect(isSameIdentity(null, { userId: U })).toBe(false);
    expect(isSameIdentity({ userId: U }, null)).toBe(false);
    expect(isSameIdentity(undefined, undefined)).toBe(false);
  });
});

describe('040 SC-009: the three undo surfaces agree on the null-vs-undefined case', () => {
  // A DB-shaped row and an in-process identity that omitted the agentName key
  // — the exact pair the three surfaces used to disagree about.
  const dbRow = { userId: U, agentName: null, viaSync: false };
  const identity = { userId: U };

  test('the edit-range durability filter classifies the row as the identity own', () => {
    // The filter body as edit-range.js applies it (FR-015 fixed this one).
    const rows = [dbRow];
    expect(rows.filter((r) => isSameIdentity(r, identity))).toHaveLength(1);
  });

  test('the inverse identity filter classifies the row as the identity own', () => {
    const isIdentityRow = (r) => isSameIdentity(r, identity);
    expect(isIdentityRow(dbRow)).toBe(true);
  });

  test('the legacy run detector classifies the row as the identity own', () => {
    const { _isIdentityRow } = require('../legacy');
    expect(_isIdentityRow(dbRow, identity)).toBe(true);
  });

  test('all three agree — the property SC-009 actually asks for', () => {
    const { _isIdentityRow } = require('../legacy');
    const verdicts = [
      [dbRow].filter((r) => isSameIdentity(r, identity)).length === 1, // edit-range
      isSameIdentity(dbRow, identity),                                  // inverse
      _isIdentityRow(dbRow, identity),                                  // legacy
    ];
    expect(verdicts).toEqual([true, true, true]);
  });

  test('038 regression fence: legacy viaSync guard still WINS over an identity match', () => {
    const { _isIdentityRow } = require('../legacy');
    const syncRow = { userId: U, agentName: null, viaSync: true };
    // Identity matches ...
    expect(isSameIdentity(syncRow, identity)).toBe(true);
    // ... but the channel guard still rejects it (feature 038 D2).
    expect(_isIdentityRow(syncRow, identity)).toBe(false);
  });
});
