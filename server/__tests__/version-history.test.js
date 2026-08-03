/**
 * Tests for version-history module
 */
const {
  generateColorFromId,
  createAuthor,
  groupUpdatesIntoVersions,
  UNKNOWN_AUTHOR,
  mergeNamedVersions,
  formatTimestamp,
  restoreVersion,
  getVersionTimeline,
  getVersionContent,
  getContentAtClock,
  getUpdatesForVersion,
  getCurrentSessionAuthors,
  VersionNotFoundError,
  DocumentSyncingError,
  DEFAULT_INACTIVITY_THRESHOLD,
} = require('../version-history');
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser, cleanupDocRows } = require('./helpers/db');
const { asLiveSharedDoc } = require('./helpers/live-doc');
const editRecords = require('../undo/edit-records');
const undoService = require('../undo/undo-service');

describe('version-history module', () => {
  describe('generateColorFromId', () => {
    test('returns default color for null/undefined id', () => {
      expect(generateColorFromId(null)).toBe('#888888');
      expect(generateColorFromId(undefined)).toBe('#888888');
      expect(generateColorFromId('')).toBe('#888888');
    });

    test('generates deterministic color for same id', () => {
      const color1 = generateColorFromId('user-123');
      const color2 = generateColorFromId('user-123');
      expect(color1).toBe(color2);
    });

    test('generates different colors for different ids', () => {
      const color1 = generateColorFromId('user-123');
      const color2 = generateColorFromId('user-456');
      expect(color1).not.toBe(color2);
    });

    test('returns HSL color format', () => {
      const color = generateColorFromId('test-user');
      expect(color).toMatch(/^hsl\(\d+, 70%, 45%\)$/);
    });
  });

  // T026 (feature 040, FR-008, SC-005): a version whose rows exist must never
  // render an empty contributor list. Unattributed rows are real history —
  // usually edits by a since-deleted account, kept because
  // yjs_updates.user_id is ON DELETE SET NULL.
  describe('040 T026: unattributed rows render one "Unknown author" contributor (FR-008)', () => {
    const at = (ms) => new Date(new Date('2024-01-01T10:00:00Z').getTime() + ms).toISOString();

    test('(a) a version built ENTIRELY from unattributed rows shows exactly one Unknown author', () => {
      const versions = groupUpdatesIntoVersions([
        { clock: 1, createdAt: at(0), userId: null },
        { clock: 2, createdAt: at(1000), userId: null },
      ]);
      expect(versions).toHaveLength(1);
      expect(versions[0].authors).toHaveLength(1);
      expect(versions[0].authors[0]).toEqual(UNKNOWN_AUTHOR);
      expect(versions[0].authors[0].name).toBe('Unknown author');
      expect(versions[0].authors[0].id).toBeNull();
      expect(versions[0].authors[0].color).toBe('#888888');
    });

    test('(b) a MIXED version shows the real authors PLUS exactly one Unknown author', () => {
      const versions = groupUpdatesIntoVersions([
        { clock: 1, createdAt: at(0), userId: 'user-1', userName: 'Alice' },
        { clock: 2, createdAt: at(1000), userId: null },
        { clock: 3, createdAt: at(2000), userId: 'user-2', userName: 'Bob' },
      ]);
      expect(versions).toHaveLength(1);
      const names = versions[0].authors.map((a) => a.name).sort();
      expect(names).toEqual(['Alice', 'Bob', 'Unknown author']);
      expect(versions[0].authors.filter((a) => a.id === null)).toHaveLength(1);
    });

    test('(c) MANY unattributed rows still collapse to exactly one entry', () => {
      const updates = Array.from({ length: 25 }, (_, i) => ({
        clock: i + 1, createdAt: at(i * 100), userId: null,
      }));
      const versions = groupUpdatesIntoVersions(updates);
      const unknowns = versions.flatMap((v) => v.authors).filter((a) => a.id === null);
      expect(unknowns).toHaveLength(1);
    });

    test('(e) a fully attributed version shows NO phantom Unknown author', () => {
      const versions = groupUpdatesIntoVersions([
        { clock: 1, createdAt: at(0), userId: 'user-1', userName: 'Alice' },
        { clock: 2, createdAt: at(1000), userId: 'user-1', userName: 'Alice' },
      ]);
      expect(versions[0].authors).toHaveLength(1);
      expect(versions[0].authors.every((a) => a.id !== null)).toBe(true);
    });

    test('(d) the sub-version DRILL-DOWN gets the same treatment — via the same grouping function, not a duplicate', async () => {
      const mockPersistence = {
        getUpdatesInRange: async () => ([
          { clock: 1, createdAt: at(0), userId: null, userName: null, agentName: null },
          { clock: 2, createdAt: at(500), userId: null, userName: null, agentName: null },
          { clock: 3, createdAt: at(1000), userId: 'user-1', userName: 'Alice', agentName: null },
        ]),
      };
      const result = await getUpdatesForVersion(mockPersistence, 'doc-1', 1, 3);
      const authors = result.subversions.flatMap((sv) => sv.authors);
      const unknowns = authors.filter((a) => a.id === null);
      expect(unknowns.length).toBeGreaterThan(0);
      expect(unknowns[0].name).toBe('Unknown author');
      expect(unknowns[0].color).toBe('#888888');
      // Still collapsed to one per sub-version.
      result.subversions.forEach((sv) => {
        expect(sv.authors.filter((a) => a.id === null).length).toBeLessThanOrEqual(1);
      });
    });

    test('an agent edit whose user was deleted is still attributed as unknown, not skipped', () => {
      // agentName present but userId gone — createAuthor returns null here,
      // so before 040 the row vanished from the contributor list entirely.
      const versions = groupUpdatesIntoVersions([
        { clock: 1, createdAt: at(0), userId: null, agentName: 'Some Agent' },
      ]);
      expect(versions[0].authors).toHaveLength(1);
      expect(versions[0].authors[0].name).toBe('Unknown author');
    });
  });

  describe('groupUpdatesIntoVersions', () => {
    test('returns empty array for empty/null updates', () => {
      expect(groupUpdatesIntoVersions([])).toEqual([]);
      expect(groupUpdatesIntoVersions(null)).toEqual([]);
      expect(groupUpdatesIntoVersions(undefined)).toEqual([]);
    });

    test('groups single update into one version', () => {
      const updates = [
        { clock: 1, createdAt: '2024-01-01T10:00:00Z', userId: 'user-1', userName: 'Alice' }
      ];

      const versions = groupUpdatesIntoVersions(updates);

      expect(versions).toHaveLength(1);
      expect(versions[0].clockStart).toBe(1);
      expect(versions[0].clockEnd).toBe(1);
      expect(versions[0].authors).toHaveLength(1);
      expect(versions[0].authors[0].name).toBe('Alice');
    });

    test('groups consecutive updates within threshold into one version', () => {
      const baseTime = new Date('2024-01-01T10:00:00Z').getTime();
      const updates = [
        { clock: 1, createdAt: new Date(baseTime).toISOString(), userId: 'user-1', userName: 'Alice' },
        { clock: 2, createdAt: new Date(baseTime + 1000).toISOString(), userId: 'user-1', userName: 'Alice' }, // 1 sec later
        { clock: 3, createdAt: new Date(baseTime + 1000).toISOString(), userId: 'user-2', userName: 'Bob' }, // 2 sec later
      ];

      const versions = groupUpdatesIntoVersions(updates);

      expect(versions).toHaveLength(1);
      expect(versions[0].clockStart).toBe(1);
      expect(versions[0].clockEnd).toBe(3);
      expect(versions[0].authors).toHaveLength(2);
    });

    test('creates new version after inactivity threshold', () => {
      const baseTime = new Date('2024-01-01T10:00:00Z').getTime();
      const updates = [
        { clock: 1, createdAt: new Date(baseTime).toISOString(), userId: 'user-1', userName: 'Alice' },
        { clock: 2, createdAt: new Date(baseTime + DEFAULT_INACTIVITY_THRESHOLD + 1000).toISOString(), userId: 'user-1', userName: 'Alice' },
      ];

      const versions = groupUpdatesIntoVersions(updates);

      expect(versions).toHaveLength(2);
      expect(versions[0].clockEnd).toBe(1);
      expect(versions[1].clockStart).toBe(2);
    });

    test('respects custom inactivity threshold', () => {
      const baseTime = new Date('2024-01-01T10:00:00Z').getTime();
      const customThreshold = 1000; // 1 second

      const updates = [
        { clock: 1, createdAt: new Date(baseTime).toISOString(), userId: 'user-1', userName: 'Alice' },
        { clock: 2, createdAt: new Date(baseTime + 2000).toISOString(), userId: 'user-1', userName: 'Alice' }, // 2 sec later
      ];

      const versions = groupUpdatesIntoVersions(updates, customThreshold);

      expect(versions).toHaveLength(2);
    });

    test('tracks unique authors per version', () => {
      const baseTime = new Date('2024-01-01T10:00:00Z').getTime();
      const updates = [
        { clock: 1, createdAt: new Date(baseTime).toISOString(), userId: 'user-1', userName: 'Alice' },
        { clock: 2, createdAt: new Date(baseTime + 1000).toISOString(), userId: 'user-1', userName: 'Alice' }, // Same user
        { clock: 3, createdAt: new Date(baseTime + 2000).toISOString(), userId: 'user-2', userName: 'Bob' },
        { clock: 4, createdAt: new Date(baseTime + 3000).toISOString(), userId: 'user-1', userName: 'Alice' }, // Same user again
      ];

      const versions = groupUpdatesIntoVersions(updates);

      expect(versions).toHaveLength(1);
      expect(versions[0].authors).toHaveLength(2); // Only 2 unique authors
    });

    // ⚠️ INVERTED BY FEATURE 040 (FR-008). This case previously asserted
    // `authors` was EMPTY for a row with no user info. That empty list is the
    // defect: a version that demonstrably exists rendered as though nobody
    // had edited it. It now shows one synthetic "Unknown author" contributor.
    test('handles updates without user info — one Unknown author, not an empty list (040 FR-008 inverted this)', () => {
      const updates = [
        { clock: 1, createdAt: '2024-01-01T10:00:00Z' }, // No user info
      ];

      const versions = groupUpdatesIntoVersions(updates);

      expect(versions).toHaveLength(1);
      expect(versions[0].authors).toHaveLength(1);
      expect(versions[0].authors[0].name).toBe('Unknown author');
      expect(versions[0].authors[0].id).toBeNull();
    });
  });

  describe('onBehalfOf provenance dedupe and cap (feature 004, review note #5)', () => {
    const baseTime = new Date('2024-01-01T10:00:00Z').getTime();
    // Updates within the same version window (1s apart), chronological order.
    const mk = (clock, onBehalfOf) => ({
      clock,
      createdAt: new Date(baseTime + clock * 1000).toISOString(),
      userId: 'user-1',
      userName: 'Alice',
      onBehalfOf,
    });

    test('dedupes pushes by identity, aggregating push count and latest commit/url', () => {
      const updates = [
        mk(1, { name: 'CI Bot', email: 'ci@x.com', commit: 'aaa111' }),
        mk(2, { name: 'CI Bot', email: 'ci@x.com', commit: 'bbb222' }),
        mk(3, { name: 'CI Bot', email: 'ci@x.com', commit: 'ccc333', url: 'https://x/c3' }),
        mk(4, { name: 'Dev', email: 'dev@x.com', commit: 'ddd444' }),
      ];

      const versions = groupUpdatesIntoVersions(updates);

      expect(versions).toHaveLength(1);
      const obo = versions[0].onBehalfOf;
      expect(obo).toHaveLength(2); // two distinct identities

      const ci = obo.find(e => e.email === 'ci@x.com');
      expect(ci).toMatchObject({
        name: 'CI Bot',
        email: 'ci@x.com',
        commitCount: 3,
        latestCommit: 'ccc333', // most recent (chronological last wins)
        latestUrl: 'https://x/c3',
      });

      const dev = obo.find(e => e.email === 'dev@x.com');
      expect(dev).toMatchObject({ name: 'Dev', commitCount: 1, latestCommit: 'ddd444' });
      expect(dev.latestUrl).toBeUndefined();

      expect(versions[0].onBehalfOfMore).toBe(0);
    });

    test('caps distinct identities at 10 with an overflow count', () => {
      const updates = [];
      for (let i = 0; i < 15; i++) {
        updates.push(mk(i + 1, { name: `Pusher ${i}`, email: `p${i}@x.com`, commit: `c${i}` }));
      }

      const versions = groupUpdatesIntoVersions(updates);

      expect(versions).toHaveLength(1);
      expect(versions[0].onBehalfOf).toHaveLength(10);
      expect(versions[0].onBehalfOfMore).toBe(5);
      // First-seen identities are retained.
      expect(versions[0].onBehalfOf[0]).toMatchObject({ name: 'Pusher 0' });
      expect(versions[0].onBehalfOf[9]).toMatchObject({ name: 'Pusher 9' });
    });

    test('collapses entries with neither name nor email into one anonymous identity', () => {
      const updates = [
        mk(1, { commit: 'aaa' }),
        mk(2, { commit: 'bbb' }),
      ];

      const versions = groupUpdatesIntoVersions(updates);

      expect(versions[0].onBehalfOf).toHaveLength(1);
      expect(versions[0].onBehalfOf[0]).toMatchObject({ commitCount: 2, latestCommit: 'bbb' });
      expect(versions[0].onBehalfOfMore).toBe(0);
    });

    test('versions without push provenance have an empty list and zero overflow', () => {
      const versions = groupUpdatesIntoVersions([mk(1, undefined)]);
      expect(versions[0].onBehalfOf).toEqual([]);
      expect(versions[0].onBehalfOfMore).toBe(0);
    });

    test('preserves hostile strings verbatim (client renders them inertly)', () => {
      const hostile = '<img src=x onerror=alert(1)>';
      const versions = groupUpdatesIntoVersions([
        mk(1, { name: hostile, email: hostile, commit: hostile, url: hostile }),
      ]);

      const e = versions[0].onBehalfOf[0];
      expect(e.name).toBe(hostile);
      expect(e.email).toBe(hostile);
      expect(e.latestCommit).toBe(hostile);
      expect(e.latestUrl).toBe(hostile);
      expect(e.commitCount).toBe(1);
    });
  });

  describe('mergeNamedVersions', () => {
    test('returns auto versions with ids when no named versions', () => {
      const autoVersions = [
        { clockStart: 1, clockEnd: 5, timestamp: '2024-01-01T10:00:00Z', authors: [] },
        { clockStart: 6, clockEnd: 10, timestamp: '2024-01-01T11:00:00Z', authors: [] },
      ];

      const result = mergeNamedVersions(autoVersions, []);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('5');
      expect(result[1].id).toBe('10');
      expect(result[1].isCurrent).toBe(true); // Most recent
    });

    test('merges named versions with auto versions', () => {
      const autoVersions = [
        { clockStart: 1, clockEnd: 5, timestamp: '2024-01-01T10:00:00Z', authors: [] },
        { clockStart: 6, clockEnd: 10, timestamp: '2024-01-01T11:00:00Z', authors: [] },
      ];

      const namedVersions = [
        {
          id: 'named-uuid-123',
          name: 'Final Draft',
          clock_start: 6,
          clock_end: 10,
          created_at: '2024-01-01T11:00:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
      ];

      const result = mergeNamedVersions(autoVersions, namedVersions);

      // Named version should replace overlapping auto version
      expect(result).toHaveLength(2);
      const named = result.find(v => v.id === 'named-uuid-123');
      expect(named).toBeDefined();
      expect(named.name).toBe('Final Draft');
      expect(named.isNamed).toBe(true);
    });

    test('marks most recent version as current', () => {
      const autoVersions = [
        { clockStart: 1, clockEnd: 5, timestamp: '2024-01-01T10:00:00Z', authors: [] },
        { clockStart: 6, clockEnd: 10, timestamp: '2024-01-01T11:00:00Z', authors: [] },
      ];

      const result = mergeNamedVersions(autoVersions, []);

      // When no named versions, last item in input order is marked as current
      expect(result[1].isCurrent).toBe(true);
      expect(result[1].clockEnd).toBe(10);
      expect(result[0].isCurrent).toBe(false);
    });

    test('handles empty auto versions', () => {
      const result = mergeNamedVersions([], []);
      expect(result).toEqual([]);
    });

    test('splits auto version when named version covers beginning portion', () => {
      // Bug case: naming clock 59 should create named version 57-59,
      // leaving only clock 60 in the auto version
      const autoVersions = [
        { clockStart: 57, clockEnd: 60, timestamp: '2024-01-01T10:00:00Z', authors: [] },
      ];

      const namedVersions = [
        {
          id: 'biz5-uuid',
          name: 'biz5',
          clock_start: 57,
          clock_end: 59,
          created_at: '2024-01-01T10:00:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
      ];

      const result = mergeNamedVersions(autoVersions, namedVersions);

      // Should have 2 versions: the remaining auto fragment (60-60) and the named version (57-59)
      expect(result).toHaveLength(2);

      // Find the auto fragment - should only contain clock 60
      const autoFragment = result.find(v => v.id === '60');
      expect(autoFragment).toBeDefined();
      expect(autoFragment.clockStart).toBe(60);
      expect(autoFragment.clockEnd).toBe(60);
      expect(autoFragment.isNamed).toBe(false);

      // Find the named version - should contain clocks 57-59
      const namedVersion = result.find(v => v.id === 'biz5-uuid');
      expect(namedVersion).toBeDefined();
      expect(namedVersion.clockStart).toBe(57);
      expect(namedVersion.clockEnd).toBe(59);
      expect(namedVersion.isNamed).toBe(true);
      expect(namedVersion.name).toBe('biz5');
    });

    test('splits auto version when named version covers end portion', () => {
      // Named version covers the end of the auto version
      const autoVersions = [
        { clockStart: 50, clockEnd: 60, timestamp: '2024-01-01T10:00:00Z', authors: [] },
      ];

      const namedVersions = [
        {
          id: 'final-uuid',
          name: 'Final',
          clock_start: 58,
          clock_end: 60,
          created_at: '2024-01-01T10:00:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
      ];

      const result = mergeNamedVersions(autoVersions, namedVersions);

      expect(result).toHaveLength(2);

      // Fragment before the named version (50-57)
      const autoFragment = result.find(v => v.id === '57');
      expect(autoFragment).toBeDefined();
      expect(autoFragment.clockStart).toBe(50);
      expect(autoFragment.clockEnd).toBe(57);
      expect(autoFragment.isNamed).toBe(false);

      // Named version (58-60)
      const namedVersion = result.find(v => v.id === 'final-uuid');
      expect(namedVersion).toBeDefined();
      expect(namedVersion.clockStart).toBe(58);
      expect(namedVersion.clockEnd).toBe(60);
    });

    test('splits auto version when named version is in the middle', () => {
      // Named version is in the middle of the auto version
      const autoVersions = [
        { clockStart: 50, clockEnd: 60, timestamp: '2024-01-01T10:00:00Z', authors: [] },
      ];

      const namedVersions = [
        {
          id: 'middle-uuid',
          name: 'Middle',
          clock_start: 54,
          clock_end: 56,
          created_at: '2024-01-01T10:00:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
      ];

      const result = mergeNamedVersions(autoVersions, namedVersions);

      expect(result).toHaveLength(3);

      // Fragment after the named version (57-60)
      const afterFragment = result.find(v => v.id === '60');
      expect(afterFragment).toBeDefined();
      expect(afterFragment.clockStart).toBe(57);
      expect(afterFragment.clockEnd).toBe(60);

      // Named version (54-56)
      const namedVersion = result.find(v => v.id === 'middle-uuid');
      expect(namedVersion).toBeDefined();
      expect(namedVersion.clockStart).toBe(54);
      expect(namedVersion.clockEnd).toBe(56);

      // Fragment before the named version (50-53)
      const beforeFragment = result.find(v => v.id === '53');
      expect(beforeFragment).toBeDefined();
      expect(beforeFragment.clockStart).toBe(50);
      expect(beforeFragment.clockEnd).toBe(53);
    });

    test('handles multiple named versions splitting single auto version', () => {
      // Two named versions split one auto version into three fragments
      const autoVersions = [
        { clockStart: 1, clockEnd: 20, timestamp: '2024-01-01T10:00:00Z', authors: [] },
      ];

      const namedVersions = [
        {
          id: 'first-uuid',
          name: 'First',
          clock_start: 5,
          clock_end: 8,
          created_at: '2024-01-01T10:00:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
        {
          id: 'second-uuid',
          name: 'Second',
          clock_start: 12,
          clock_end: 15,
          created_at: '2024-01-01T10:01:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
      ];

      const result = mergeNamedVersions(autoVersions, namedVersions);

      // Should have 5 items: 3 auto fragments + 2 named versions
      expect(result).toHaveLength(5);

      // Fragment after second named (16-20)
      expect(result.find(v => v.clockStart === 16 && v.clockEnd === 20)).toBeDefined();
      // Fragment between named versions (9-11)
      expect(result.find(v => v.clockStart === 9 && v.clockEnd === 11)).toBeDefined();
      // Fragment before first named (1-4)
      expect(result.find(v => v.clockStart === 1 && v.clockEnd === 4)).toBeDefined();
      // Named versions
      expect(result.find(v => v.id === 'first-uuid')).toBeDefined();
      expect(result.find(v => v.id === 'second-uuid')).toBeDefined();
    });

    test('does not create overlapping versions when named version covers exact range', () => {
      // When named version exactly matches auto version, no fragments should be created
      const autoVersions = [
        { clockStart: 57, clockEnd: 60, timestamp: '2024-01-01T10:00:00Z', authors: [] },
      ];

      const namedVersions = [
        {
          id: 'exact-uuid',
          name: 'Exact Match',
          clock_start: 57,
          clock_end: 60,
          created_at: '2024-01-01T10:00:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
      ];

      const result = mergeNamedVersions(autoVersions, namedVersions);

      // Should only have the named version, no auto fragments
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('exact-uuid');
      expect(result[0].isNamed).toBe(true);
    });

    test('ensures no overlapping clock ranges in result', () => {
      // Verify that the result has no overlapping clock ranges
      const autoVersions = [
        { clockStart: 1, clockEnd: 10, timestamp: '2024-01-01T10:00:00Z', authors: [] },
        { clockStart: 11, clockEnd: 20, timestamp: '2024-01-01T11:00:00Z', authors: [] },
      ];

      const namedVersions = [
        {
          id: 'overlap-uuid',
          name: 'Named',
          clock_start: 5,
          clock_end: 15,
          created_at: '2024-01-01T10:30:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
      ];

      const result = mergeNamedVersions(autoVersions, namedVersions);

      // Check that no two versions have overlapping ranges
      for (let i = 0; i < result.length; i++) {
        for (let j = i + 1; j < result.length; j++) {
          const v1 = result[i];
          const v2 = result[j];
          const overlaps = v1.clockStart <= v2.clockEnd && v1.clockEnd >= v2.clockStart;
          expect(overlaps).toBe(false);
        }
      }

      // Verify expected structure: auto-4 (1-4), named (5-15), auto-20 (16-20)
      expect(result).toHaveLength(3);
      expect(result.find(v => v.clockStart === 1 && v.clockEnd === 4)).toBeDefined();
      expect(result.find(v => v.id === 'overlap-uuid')).toBeDefined();
      expect(result.find(v => v.clockStart === 16 && v.clockEnd === 20)).toBeDefined();
    });

    test('original auto version should NOT appear when named version overlaps', () => {
      // This is the exact bug scenario: auto version 57-60, named version 57-59
      // The original auto version (57-60) should NOT be in the result
      const autoVersions = [
        { clockStart: 57, clockEnd: 60, timestamp: '2024-01-01T10:00:00Z', authors: [] },
      ];

      const namedVersions = [
        {
          id: 'biz5-uuid',
          name: 'biz5',
          clock_start: 57,
          clock_end: 59,
          created_at: '2024-01-01T10:00:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
      ];

      const result = mergeNamedVersions(autoVersions, namedVersions);

      // Should NOT have the original auto version (57-60)
      const originalAuto = result.find(v => v.clockStart === 57 && v.clockEnd === 60);
      expect(originalAuto).toBeUndefined();

      // SHOULD have the fragment (60-60)
      const fragment = result.find(v => v.clockStart === 60 && v.clockEnd === 60);
      expect(fragment).toBeDefined();
      expect(fragment.isNamed).toBe(false);

      // SHOULD have the named version (57-59)
      const named = result.find(v => v.clockStart === 57 && v.clockEnd === 59);
      expect(named).toBeDefined();
      expect(named.isNamed).toBe(true);
      expect(named.name).toBe('biz5');
    });

    test('handles null clock_start gracefully', () => {
      // Test that a named version with null clock_start still works
      // (should use the clockEnd for overlap check)
      const autoVersions = [
        { clockStart: 57, clockEnd: 60, timestamp: '2024-01-01T10:00:00Z', authors: [] },
      ];

      const namedVersions = [
        {
          id: 'old-uuid',
          name: 'OldVersion',
          clock_start: null, // NULL from database
          clock_end: 59,
          created_at: '2024-01-01T10:00:00Z',
          created_by: 'user-1',
          creator_name: 'Alice',
        },
      ];

      const result = mergeNamedVersions(autoVersions, namedVersions);

      // With null clockStart, overlap check would use: null <= 60 (true in JS due to null -> 0)
      // AND 59 >= 57 (true), so overlap IS detected
      // But the split logic would fail because nv.clockStart is null
      // currentEnd = null - 1 = -1
      // Then autoVersion.clockStart (57) <= currentEnd (-1) is FALSE
      // So no "before" fragment is created

      // This test documents the current behavior with null clock_start
      // The named version should still be included
      const named = result.find(v => v.id === 'old-uuid');
      expect(named).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Feature 041 US1 (FR-001..004): a version's authors/provenance come from the
  // rows in its OWN clock range — never inherited from the containing auto
  // version. T002 is the PINNED bidirectional regression (ledger N-041-1): when
  // a named version splits one editing burst between two people, neither side
  // may credit the other.
  // ───────────────────────────────────────────────────────────────────────────
  describe('041 T002 (PINNED, N-041-1): range-scoped authors across a named-version split', () => {
    const base = new Date('2024-05-01T10:00:00Z').getTime();
    // One burst: every row 1s apart, far inside DEFAULT_INACTIVITY_THRESHOLD,
    // so grouping produces exactly ONE auto version spanning clocks 1-10.
    const row = (clock, who, extra = {}) => ({
      clock,
      createdAt: new Date(base + clock * 1000).toISOString(),
      userId: who === 'A' ? 'user-a' : 'user-b',
      userName: who === 'A' ? 'Alice' : 'Bob',
      userEmail: who === 'A' ? 'alice@example.com' : 'bob@example.com',
      userPicture: null,
      agentName: null,
      meaningful: true,
      ...extra,
    });

    // A owns clocks 1-5, B owns clocks 6-10.
    const burst = [
      row(1, 'A'), row(2, 'A'), row(3, 'A'), row(4, 'A'), row(5, 'A'),
      row(6, 'B'), row(7, 'B'), row(8, 'B'), row(9, 'B'), row(10, 'B'),
    ];

    const namedOver = (clockStart, clockEnd) => ([{
      id: `named-${clockStart}-${clockEnd}`,
      name: `Named ${clockStart}-${clockEnd}`,
      clock_start: clockStart,
      clock_end: clockEnd,
      created_at: new Date(base + clockEnd * 1000).toISOString(),
      created_by: 'user-a',
      creator_name: 'Alice',
    }]);

    const idsOf = (v) => (v.authors || []).map(a => a.id).sort();

    test('(a) naming A\'s sub-range credits only A on it, and only B on the surviving fragment', () => {
      const autoVersions = groupUpdatesIntoVersions(burst);
      expect(autoVersions).toHaveLength(1); // single burst — the A1 precondition

      const result = mergeNamedVersions(autoVersions, namedOver(1, 5), burst);

      const named = result.find(v => v.id === 'named-1-5');
      expect(named).toBeDefined();
      expect(idsOf(named)).toEqual(['user-a']);
      // The creator badge is separate from authorship and is unaffected.
      expect(named.createdBy.id).toBe('user-a');

      const fragment = result.find(v => !v.isNamed);
      expect(fragment.clockStart).toBe(6);
      expect(fragment.clockEnd).toBe(10);
      expect(idsOf(fragment)).toEqual(['user-b']);
    });

    test('(b) MIRRORED: naming B\'s sub-range credits only B on it, and only A on the fragment', () => {
      const autoVersions = groupUpdatesIntoVersions(burst);
      const result = mergeNamedVersions(autoVersions, namedOver(6, 10), burst);

      const named = result.find(v => v.id === 'named-6-10');
      expect(idsOf(named)).toEqual(['user-b']);

      const fragment = result.find(v => !v.isNamed);
      expect(fragment.clockStart).toBe(1);
      expect(fragment.clockEnd).toBe(5);
      expect(idsOf(fragment)).toEqual(['user-a']);
    });

    test('(c) onBehalfOf provenance is scoped per range — a sync push in one sub-range never leaks into the other', () => {
      const push = { name: 'CI Bot', email: 'ci@example.com', commit: 'abc1234' };
      const burstWithPush = burst.map(u => (u.clock === 3 ? { ...u, onBehalfOf: push } : u));

      const autoVersions = groupUpdatesIntoVersions(burstWithPush);
      // Sanity: the parent auto version DOES carry the push — that is exactly
      // the metadata the fragments used to inherit.
      expect(autoVersions[0].onBehalfOf).toHaveLength(1);

      const result = mergeNamedVersions(autoVersions, namedOver(1, 5), burstWithPush);

      const named = result.find(v => v.id === 'named-1-5');
      expect(named.onBehalfOf).toHaveLength(1);
      expect(named.onBehalfOf[0].name).toBe('CI Bot');
      expect(named.onBehalfOfMore).toBe(0);

      const fragment = result.find(v => !v.isNamed);
      expect(fragment.clockStart).toBe(6);
      expect(fragment.onBehalfOf).toEqual([]);
      expect(fragment.onBehalfOfMore).toBe(0);
    });

    test('(d) end-to-end through getVersionTimeline: neither side of the split credits the other', async () => {
      const mockPersistence = {
        getUpdatesWithUsers: async () => burst,
        getNamedVersions: async () => namedOver(1, 5),
      };

      const { versions } = await getVersionTimeline(mockPersistence, 'doc-041');

      const named = versions.find(v => v.isNamed);
      expect(named.authors.map(a => a.id)).toEqual(['user-a']);

      const fragment = versions.find(v => !v.isNamed);
      expect(fragment.authors.map(a => a.id)).toEqual(['user-b']);
    });
  });

  describe('041 T003: named-version metadata resolves from its own range (FR-003, A7 / R16)', () => {
    const base = new Date('2024-05-02T10:00:00Z').getTime();
    const mk = (clock, over = {}) => ({
      clock,
      createdAt: new Date(base + clock * 1000).toISOString(),
      userId: 'user-a',
      userName: 'Alice',
      userEmail: 'alice@example.com',
      userPicture: null,
      agentName: null,
      meaningful: true,
      ...over,
    });

    test('a named version whose boundary row is noise still gets authors + timestamp from its own range', () => {
      // Clock 5 is classified noise, so the meaningful-filtered timeline has NO
      // auto version ending at 5 — the old matching-auto-version lookup missed
      // and left the named version authorless with a fallback timestamp (A7).
      const all = [mk(1), mk(2), mk(3), mk(4), mk(5, { meaningful: false }), mk(6), mk(7)];
      const meaningful = all.filter(u => u.meaningful !== false);
      const autoVersions = groupUpdatesIntoVersions(meaningful);

      const result = mergeNamedVersions(autoVersions, [{
        id: 'noise-boundary',
        name: 'Ends on noise',
        clock_start: 1,
        clock_end: 5,
        created_at: '2030-01-01T00:00:00Z', // deliberately wrong fallback
        created_by: 'user-a',
        creator_name: 'Alice',
      }], meaningful);

      const named = result.find(v => v.id === 'noise-boundary');
      expect(named.authors.map(a => a.id)).toEqual(['user-a']);
      // Last MEANINGFUL row in range is clock 4, not the created_at fallback.
      expect(named.timestamp).toBe(new Date(base + 4 * 1000).toISOString());
    });

    test('a noise-only named range falls back to the UNFILTERED in-range rows (R16) — real authors, never phantom outside ones', () => {
      const all = [
        mk(1, { meaningful: false, userId: 'user-b', userName: 'Bob', userEmail: 'bob@example.com' }),
        mk(2, { meaningful: false, userId: 'user-b', userName: 'Bob', userEmail: 'bob@example.com' }),
        mk(3),
        mk(4),
      ];
      const meaningful = all.filter(u => u.meaningful !== false);
      const autoVersions = groupUpdatesIntoVersions(meaningful);

      // mergeNamedVersions receives the UNFILTERED rows (exactly what
      // getVersionTimeline passes) so it can tell "no rows at all" apart from
      // "all noise" — the latter still has real editors to credit.
      const result = mergeNamedVersions(autoVersions, [{
        id: 'noise-only',
        name: 'All noise',
        clock_start: 1,
        clock_end: 2,
        created_at: '2024-05-02T09:00:00Z',
        created_by: 'user-a',
        creator_name: 'Alice',
      }], all);

      const named = result.find(v => v.id === 'noise-only');
      expect(named.authors.map(a => a.id)).toEqual(['user-b']);
      expect(named.authors.map(a => a.id)).not.toContain('user-a');
    });

    test('end-to-end: getVersionTimeline credits a noise-only named range from its own rows, not an empty list', async () => {
      const all = [
        mk(1, { meaningful: false, userId: 'user-b', userName: 'Bob', userEmail: 'bob@example.com' }),
        mk(2, { meaningful: false, userId: 'user-b', userName: 'Bob', userEmail: 'bob@example.com' }),
        mk(3),
        mk(4),
      ];
      const persistence = {
        getUpdatesWithUsers: async () => all,
        getNamedVersions: async () => ([{
          id: 'noise-only',
          name: 'All noise',
          clock_start: 1,
          clock_end: 2,
          created_at: '2024-05-02T09:00:00Z',
          created_by: 'user-a',
          creator_name: 'Alice',
        }]),
      };

      const { versions } = await getVersionTimeline(persistence, 'doc');
      const named = versions.find(v => v.isNamed);
      expect(named.authors.map(a => a.id)).toEqual(['user-b']);
    });

    test('a genuinely row-less named range yields an empty author list', () => {
      const rows = [mk(10), mk(11)];
      const autoVersions = groupUpdatesIntoVersions(rows);

      const result = mergeNamedVersions(autoVersions, [{
        id: 'rowless',
        name: 'Nothing here',
        clock_start: 100,
        clock_end: 105,
        created_at: '2024-05-02T09:00:00Z',
        created_by: 'user-a',
        creator_name: 'Alice',
      }], rows);

      const named = result.find(v => v.id === 'rowless');
      expect(named.authors).toEqual([]);
      // Timestamp falls back to created_at (no in-range row to date it).
      expect(named.timestamp).toBe('2024-05-02T09:00:00Z');
    });

    test('an all-unattributed named range collapses to the single Unknown author (040 FR-008 preserved)', () => {
      const rows = [
        mk(1, { userId: null, userName: null, userEmail: null }),
        mk(2, { userId: null, userName: null, userEmail: null }),
        mk(3),
      ];
      const autoVersions = groupUpdatesIntoVersions(rows);

      const result = mergeNamedVersions(autoVersions, [{
        id: 'unattributed',
        name: 'Deleted accounts',
        clock_start: 1,
        clock_end: 2,
        created_at: '2024-05-02T09:00:00Z',
        created_by: 'user-a',
        creator_name: 'Alice',
      }], rows);

      const named = result.find(v => v.id === 'unattributed');
      expect(named.authors).toHaveLength(1);
      expect(named.authors[0]).toEqual(UNKNOWN_AUTHOR);
    });
  });

  describe('041 T004: drill-down obeys the timeline\'s meaningful rule and counts honestly (FR-004, SC-002)', () => {
    const base = new Date('2024-05-03T10:00:00Z').getTime();
    const mk = (clock, offsetMs, over = {}) => ({
      clock,
      createdAt: new Date(base + offsetMs).toISOString(),
      userId: 'user-a',
      userName: 'Alice',
      userEmail: 'alice@example.com',
      userPicture: null,
      agentName: null,
      meaningful: true,
      ...over,
    });

    test('a noise-only sub-group is never emitted, and unknown-classified rows ARE kept', async () => {
      // Group A: clocks 1-2 meaningful. Group B (>10s later): clocks 3-4, BOTH
      // noise — must vanish entirely. Group C (>10s later): clock 5 with
      // meaningful === null (unknown) — must survive (D-3 fail-visible).
      const rows = [
        mk(1, 0), mk(2, 1000),
        mk(3, 20000, { meaningful: false }), mk(4, 21000, { meaningful: false }),
        mk(5, 40000, { meaningful: null }),
      ];
      const persistence = { getUpdatesInRange: async () => rows };

      const { subversions, total } = await getUpdatesForVersion(persistence, 'doc', 1, 5);

      expect(total).toBe(2);
      expect(subversions.map(s => s.clockEnd).sort((a, b) => a - b)).toEqual([2, 5]);
      expect(subversions.find(s => s.clockStart === 3)).toBeUndefined();
    });

    test('updateCount counts surviving rows, never clock arithmetic', async () => {
      // One sub-group spanning clocks 1-5 where 2 and 4 are noise: three rows
      // survive, but clockEnd - clockStart + 1 would claim five.
      const rows = [
        mk(1, 0),
        mk(2, 500, { meaningful: false }),
        mk(3, 1000),
        mk(4, 1500, { meaningful: false }),
        mk(5, 2000),
      ];
      const persistence = { getUpdatesInRange: async () => rows };

      const { subversions } = await getUpdatesForVersion(persistence, 'doc', 1, 5);

      expect(subversions).toHaveLength(1);
      expect(subversions[0].clockStart).toBe(1);
      expect(subversions[0].clockEnd).toBe(5);
      expect(subversions[0].updateCount).toBe(3);
    });

    test('Σ drill-down counts equals the timeline\'s accounting for the same range (SC-002)', async () => {
      const rows = [
        mk(1, 0), mk(2, 1000), mk(3, 2000, { meaningful: false }),
        mk(4, 20000), mk(5, 21000, { meaningful: false }), mk(6, 22000),
      ];
      const persistence = {
        getUpdatesInRange: async () => rows,
        getUpdatesWithUsers: async () => rows,
        getNamedVersions: async () => [],
      };

      const { totalEdits } = await getVersionTimeline(persistence, 'doc');
      const { subversions } = await getUpdatesForVersion(persistence, 'doc', 1, 6);
      const drillTotal = subversions.reduce((sum, s) => sum + s.updateCount, 0);

      expect(drillTotal).toBe(totalEdits);
      expect(drillTotal).toBe(4);
    });
  });

  describe('045: relayed content is credited to its true author, never the relayer', () => {
    const base = new Date('2024-06-01T10:00:00Z').getTime();

    /** A Y.Doc with a pinned client identity. */
    const docWithClient = (clientID) => {
      const doc = new Y.Doc();
      doc.clientID = clientID;
      return doc;
    };

    /** Capture the bytes of one edit. */
    const capture = (doc, edit) => {
      let bytes = null;
      const handler = (u) => { bytes = u; };
      doc.on('update', handler);
      edit();
      doc.off('update', handler);
      return bytes;
    };

    const insert = (doc, text) => capture(doc, () => doc.getText('body').insert(0, text));

    const PEOPLE = {
      'user-a': { userName: 'Alice', userEmail: 'alice@example.com', userPicture: null },
      'user-b': { userName: 'Bob', userEmail: 'bob@example.com', userPicture: null },
    };

    /**
     * A row as the persistence layer returns it, plus the payload bytes the
     * resolver will fetch separately (the surfaces themselves never see them).
     */
    const row = (clock, userId, { agentName = null, viaSync = null, bytes = null, offsetMs = null } = {}) => ({
      clock,
      createdAt: new Date(base + (offsetMs === null ? clock * 1000 : offsetMs)).toISOString(),
      userId,
      userName: userId ? PEOPLE[userId]?.userName ?? null : null,
      userEmail: userId ? PEOPLE[userId]?.userEmail ?? null : null,
      userPicture: null,
      agentName,
      meaningful: true,
      viaSync,
      updateData: bytes,
    });

    /** A persistence double that satisfies the surfaces AND the resolver. */
    const persistenceFor = (rows, namedVersions = []) => ({
      getUpdatesWithUsers: async () => rows,
      getUpdatesInRange: async (_doc, clockStart, clockEnd) =>
        rows.filter(r => r.clock >= clockStart && r.clock <= clockEnd),
      getNamedVersions: async () => namedVersions,
      getUpdatePayloads: async (_doc, clocks) =>
        rows.filter(r => clocks.includes(r.clock)).map(r => ({ clock: r.clock, updateData: r.updateData })),
      getDirectAttributedRows: async (_doc, { afterClock = -1, beforeClock, limit = 500 }) =>
        rows
          .filter(r => r.viaSync !== true && r.userId != null)
          .filter(r => r.clock > afterClock && r.clock < beforeClock)
          .slice(0, limit)
          .map(r => ({ clock: r.clock, userId: r.userId, agentName: r.agentName, updateData: r.updateData })),
      getUserDisplayFields: async (ids) => {
        const out = new Map();
        for (const id of ids) if (PEOPLE[id]) out.set(id, PEOPLE[id]);
        return out;
      },
    });

    const authorIds = (v) => (v.authors || []).map(a => a.id);
    const authorNames = (v) => (v.authors || []).map(a => a.name);

    beforeEach(() => require('../resupply-resolution')._resetForTest());

    test('the timeline credits the recovered author and never the relaying client (FR-001, SC-001)', async () => {
      const alice = docWithClient(4001);
      const rows = [
        row(1, 'user-a', { bytes: insert(alice, 'alpha') }),
        // Bob's client relayed Alice's lost edit: Bob's stamp, Alice's content.
        row(2, 'user-b', { viaSync: true, bytes: insert(alice, 'bravo') }),
      ];

      const { versions } = await getVersionTimeline(persistenceFor(rows), 'doc-045');

      expect(versions).toHaveLength(1);
      expect(authorIds(versions[0])).toEqual(['user-a']);
      expect(authorIds(versions[0])).not.toContain('user-b');
    });

    test('a resolved origin renders identically to a direct author (FR-003)', async () => {
      const alice = docWithClient(4002);
      const relayed = [
        row(1, 'user-a', { bytes: insert(alice, 'alpha') }),
        row(2, 'user-b', { viaSync: true, bytes: insert(alice, 'bravo') }),
      ];
      const direct = [
        row(1, 'user-a', { bytes: insert(docWithClient(4003), 'alpha') }),
        row(2, 'user-a', { bytes: insert(docWithClient(4003), 'bravo') }),
      ];

      const relayedTimeline = await getVersionTimeline(persistenceFor(relayed), 'doc-relayed');
      require('../resupply-resolution')._resetForTest();
      const directTimeline = await getVersionTimeline(persistenceFor(direct), 'doc-direct');

      expect(relayedTimeline.versions[0].authors).toEqual(directTimeline.versions[0].authors);
    });

    test('an agent origin relayed through a human is credited to the agent (US1 scenario 4)', async () => {
      const agentDoc = docWithClient(4004);
      const rows = [
        row(1, 'user-a', { agentName: 'claude', bytes: insert(agentDoc, 'alpha') }),
        row(2, 'user-b', { viaSync: true, bytes: insert(agentDoc, 'bravo') }),
      ];

      const { versions } = await getVersionTimeline(persistenceFor(rows), 'doc-agent');

      expect(versions[0].authors).toHaveLength(1);
      expect(versions[0].authors[0].isAgent).toBe(true);
      expect(versions[0].authors[0].name).toBe('claude (Alice)');
    });

    test('self-relay with prior evidence keeps its author, with no synced hedging (SC-002)', async () => {
      const alice = docWithClient(4005);
      const rows = [
        row(1, 'user-a', { bytes: insert(alice, 'alpha') }),
        row(2, 'user-a', { viaSync: true, bytes: insert(alice, 'bravo') }),
      ];

      const { versions } = await getVersionTimeline(persistenceFor(rows), 'doc-self');

      expect(authorIds(versions[0])).toEqual(['user-a']);
      expect(authorNames(versions[0])).not.toContain('Synced content');
    });

    test('the drill-down agrees with the timeline (FR-001, drill-down projection carries viaSync)', async () => {
      const alice = docWithClient(4006);
      const rows = [
        row(1, 'user-a', { bytes: insert(alice, 'alpha') }),
        row(2, 'user-b', { viaSync: true, bytes: insert(alice, 'bravo') }),
      ];
      const persistence = persistenceFor(rows);

      const { subversions } = await getUpdatesForVersion(persistence, 'doc-045', 1, 2);
      const { versions } = await getVersionTimeline(persistence, 'doc-045');

      expect(subversions).toHaveLength(1);
      expect(authorIds(subversions[0])).toEqual(['user-a']);
      expect(authorIds(subversions[0])).toEqual(authorIds(versions[0]));
    });

    test('a NAMED version and both split fragments over a relayed row credit the resolved author (041 paths)', async () => {
      const alice = docWithClient(4007);
      const bob = docWithClient(4008);
      // One burst: Bob writes directly at 1-2, a relayed row of Alice's sits at
      // 3, Bob writes again at 4-5. Naming clock 3 alone splits the burst on
      // both sides of the relayed row.
      const rows = [
        row(1, 'user-b', { bytes: insert(bob, 'b1') }),
        row(2, 'user-a', { bytes: insert(alice, 'a1') }),
        row(3, 'user-b', { viaSync: true, bytes: insert(alice, 'a2') }),
        row(4, 'user-b', { bytes: insert(bob, 'b2') }),
        row(5, 'user-b', { bytes: insert(bob, 'b3') }),
      ];
      const named = [{
        id: 'named-3-3',
        name: 'Named 3',
        clock_start: 3,
        clock_end: 3,
        created_at: new Date(base + 3000).toISOString(),
        created_by: 'user-b',
        creator_name: 'Bob',
      }];

      const { versions } = await getVersionTimeline(persistenceFor(rows, named), 'doc-named');

      const namedVersion = versions.find(v => v.isNamed);
      // The named range is EXACTLY the relayed row: Alice, not the stamped Bob.
      expect(authorIds(namedVersion)).toEqual(['user-a']);

      const fragments = versions.filter(v => !v.isNamed);
      expect(fragments).toHaveLength(2);
      // The BEFORE fragment (clocks 1-2) holds Bob's own row and Alice's own
      // direct row; the AFTER fragment (4-5) is Bob's alone. Neither inherits
      // the relayed row's authorship — that belongs to the named range only.
      const before = fragments.find(f => f.clockStart === 1);
      const after = fragments.find(f => f.clockStart === 4);
      expect(authorIds(before).sort()).toEqual(['user-a', 'user-b']);
      expect(authorIds(after)).toEqual(['user-b']);
    });

    test('rows with via_sync NULL or false are displayed exactly as before (FR-008)', async () => {
      const alice = docWithClient(4009);
      const legacy = [
        row(1, 'user-a', { viaSync: null, bytes: insert(alice, 'alpha') }),
        row(2, 'user-b', { viaSync: false, bytes: insert(alice, 'bravo') }),
      ];

      const { versions } = await getVersionTimeline(persistenceFor(legacy), 'doc-legacy');

      // The stamp is the author for a row that is not known to be sync-relayed —
      // null is never suspicious (038).
      expect(authorIds(versions[0]).sort()).toEqual(['user-a', 'user-b']);
    });
  });

  describe('045: unmappable relayed content is labelled honestly (US2)', () => {
    const { SYNCED_CONTRIBUTION } = require('../version-history');
    const base = new Date('2024-06-02T10:00:00Z').getTime();

    const docWithClient = (clientID) => {
      const doc = new Y.Doc();
      doc.clientID = clientID;
      return doc;
    };
    const capture = (doc, edit) => {
      let bytes = null;
      const handler = (u) => { bytes = u; };
      doc.on('update', handler);
      edit();
      doc.off('update', handler);
      return bytes;
    };
    const insert = (doc, text) => capture(doc, () => doc.getText('body').insert(0, text));

    const row = (clock, userId, { agentName = null, viaSync = null, bytes = null } = {}) => ({
      clock,
      createdAt: new Date(base + clock * 1000).toISOString(),
      userId,
      userName: userId === 'user-a' ? 'Alice' : userId === 'user-b' ? 'Bob' : null,
      userEmail: null,
      userPicture: null,
      agentName,
      meaningful: true,
      viaSync,
      updateData: bytes,
    });

    const persistenceFor = (rows) => ({
      getUpdatesWithUsers: async () => rows,
      getUpdatesInRange: async (_doc, clockStart, clockEnd) =>
        rows.filter(r => r.clock >= clockStart && r.clock <= clockEnd),
      getNamedVersions: async () => [],
      getUpdatePayloads: async (_doc, clocks) =>
        rows.filter(r => clocks.includes(r.clock)).map(r => ({ clock: r.clock, updateData: r.updateData })),
      getDirectAttributedRows: async (_doc, { afterClock = -1, beforeClock, limit = 500 }) =>
        rows
          .filter(r => r.viaSync !== true && r.userId != null)
          .filter(r => r.clock > afterClock && r.clock < beforeClock)
          .slice(0, limit)
          .map(r => ({ clock: r.clock, userId: r.userId, agentName: r.agentName, updateData: r.updateData })),
      getUserDisplayFields: async () => new Map(),
    });

    beforeEach(() => require('../resupply-resolution')._resetForTest());

    test('a relayed row with no prior evidence renders the synced contribution, never the relayer (FR-004)', async () => {
      const stranger = docWithClient(5001);
      const rows = [row(1, 'user-b', { viaSync: true, bytes: insert(stranger, 'alpha') })];

      const { versions } = await getVersionTimeline(persistenceFor(rows), 'doc-noevidence');

      expect(versions[0].authors).toEqual([SYNCED_CONTRIBUTION]);
      expect(versions[0].authors.map(a => a.id)).not.toContain('user-b');
    });

    test('ambiguous evidence refuses rather than guessing (FR-006)', async () => {
      const shared = docWithClient(5002);
      const rows = [
        row(1, 'user-a', { bytes: insert(shared, 'a') }),
        row(2, 'user-b', { bytes: insert(shared, 'b') }),
        row(3, 'user-b', { viaSync: true, bytes: insert(shared, 'c') }),
      ];

      const { versions } = await getVersionTimeline(persistenceFor(rows), 'doc-ambiguous');

      const names = versions[0].authors.map(a => a.name);
      expect(names).toContain('Synced content');
      // Both real authors are here for their OWN direct rows; neither is
      // credited for the relayed one (the synced entry is what covers it).
      expect(versions[0].authors.filter(a => a.isSynced)).toHaveLength(1);
    });

    test('a deletion-only relayed payload fabricates no deleter (FR-005)', async () => {
      const alice = docWithClient(5003);
      const evidence = insert(alice, 'alpha');
      const bob = docWithClient(5004);
      Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
      const deletion = capture(bob, () => bob.getText('body').delete(0, 5));

      const rows = [
        row(1, 'user-a', { bytes: evidence }),
        row(2, 'user-b', { viaSync: true, bytes: deletion }),
      ];

      const { versions } = await getVersionTimeline(persistenceFor(rows), 'doc-deletion');

      const names = versions[0].authors.map(a => a.name);
      expect(names).toContain('Synced content');
      expect(names).not.toContain('Bob');
    });

    test('a version made ENTIRELY of unresolvable relayed rows shows the synced contribution, not an empty list', async () => {
      const stranger = docWithClient(5005);
      const rows = [
        row(1, 'user-b', { viaSync: true, bytes: insert(stranger, 'alpha') }),
        row(2, 'user-b', { viaSync: true, bytes: insert(stranger, 'bravo') }),
        row(3, 'user-a', { viaSync: true, bytes: insert(stranger, 'charlie') }),
      ];

      const { versions } = await getVersionTimeline(persistenceFor(rows), 'doc-allsynced');

      // Three unresolvable rows, two different relayers ⇒ exactly ONE entry.
      expect(versions[0].authors).toEqual([SYNCED_CONTRIBUTION]);
    });

    test('the synced contribution and Unknown author coexist distinguishably in one version (RBD-045-2)', async () => {
      const stranger = docWithClient(5006);
      const rows = [
        // A row whose user was deleted (user_id SET NULL) ⇒ Unknown author.
        row(1, null, { bytes: insert(stranger, 'alpha') }),
        // A relayed row with no usable evidence ⇒ Synced content.
        row(2, 'user-b', { viaSync: true, bytes: insert(stranger, 'bravo') }),
      ];

      const { versions } = await getVersionTimeline(persistenceFor(rows), 'doc-both');

      const names = versions[0].authors.map(a => a.name).sort();
      expect(names).toEqual(['Synced content', 'Unknown author']);
      expect(versions[0].authors.find(a => a.name === 'Synced content').isSynced).toBe(true);
      expect(versions[0].authors.find(a => a.name === 'Unknown author').isSynced).toBeUndefined();
    });

    test('the drill-down applies the same rule as the timeline for unresolvable rows', async () => {
      const stranger = docWithClient(5007);
      const rows = [row(1, 'user-b', { viaSync: true, bytes: insert(stranger, 'alpha') })];
      const persistence = persistenceFor(rows);

      const { subversions } = await getUpdatesForVersion(persistence, 'doc-drill-synced', 1, 1);

      expect(subversions[0].authors).toEqual([SYNCED_CONTRIBUTION]);
    });
  });

  describe('formatTimestamp', () => {
    test('formats date string to readable format', () => {
      const formatted = formatTimestamp('2024-12-10T16:44:00Z');

      // The exact output depends on locale, but should contain month and time
      expect(formatted).toContain('December');
      expect(formatted).toContain('10');
    });

    test('formats Date object', () => {
      const date = new Date('2024-12-10T16:44:00Z');
      const formatted = formatTimestamp(date);

      expect(formatted).toContain('December');
      expect(formatted).toContain('10');
    });
  });

  describe('createAuthor', () => {
    test('returns null for update without userId', () => {
      expect(createAuthor({})).toBeNull();
      expect(createAuthor({ userName: 'Test' })).toBeNull();
    });

    test('creates author object for regular user', () => {
      const update = {
        userId: 'user-123',
        userName: 'Alice',
        userEmail: 'alice@example.com',
        userPicture: 'https://example.com/pic.jpg',
      };

      const author = createAuthor(update);

      expect(author).toEqual({
        id: 'user-123',
        name: 'Alice',
        email: 'alice@example.com',
        picture: 'https://example.com/pic.jpg',
        color: expect.stringMatching(/^hsl\(\d+, 70%, 45%\)$/),
        isAgent: false,
      });
    });

    test('creates author object for agent', () => {
      const update = {
        userId: 'user-123',
        userName: 'Alice',
        userEmail: 'alice@example.com',
        agentName: 'Claude',
      };

      const author = createAuthor(update);

      expect(author.name).toBe('Claude (Alice)');
      expect(author.isAgent).toBe(true);
    });

    test('uses different color for agent vs user', () => {
      const userUpdate = { userId: 'user-123', userName: 'Alice' };
      const agentUpdate = { userId: 'user-123', userName: 'Alice', agentName: 'Claude' };

      const userAuthor = createAuthor(userUpdate);
      const agentAuthor = createAuthor(agentUpdate);

      expect(userAuthor.color).not.toBe(agentAuthor.color);
    });
  });

  describe('getCurrentSessionAuthors', () => {
    test('returns empty array for empty/null updates', () => {
      expect(getCurrentSessionAuthors([])).toEqual([]);
      expect(getCurrentSessionAuthors(null)).toEqual([]);
      expect(getCurrentSessionAuthors(undefined)).toEqual([]);
    });

    test('returns authors from single update', () => {
      const updates = [
        { clock: 1, createdAt: '2024-01-01T10:00:00Z', userId: 'user-1', userName: 'Alice' },
      ];

      const authors = getCurrentSessionAuthors(updates);

      expect(authors).toHaveLength(1);
      expect(authors[0].name).toBe('Alice');
    });

    test('returns authors from last session only', () => {
      const baseTime = new Date('2024-01-01T10:00:00Z').getTime();

      const updates = [
        // First session - Alice
        { clock: 1, createdAt: new Date(baseTime).toISOString(), userId: 'user-1', userName: 'Alice' },
        { clock: 2, createdAt: new Date(baseTime + 1000).toISOString(), userId: 'user-1', userName: 'Alice' },
        // Gap > 5 minutes (need more than threshold, not equal)
        // Second session - Bob
        { clock: 3, createdAt: new Date(baseTime + DEFAULT_INACTIVITY_THRESHOLD + 2000).toISOString(), userId: 'user-2', userName: 'Bob' },
        { clock: 4, createdAt: new Date(baseTime + DEFAULT_INACTIVITY_THRESHOLD + 3000).toISOString(), userId: 'user-2', userName: 'Bob' },
      ];

      const authors = getCurrentSessionAuthors(updates);

      // Should only return Bob (from last session)
      expect(authors).toHaveLength(1);
      expect(authors[0].name).toBe('Bob');
    });

    test('returns multiple authors from last session', () => {
      const baseTime = new Date('2024-01-01T10:00:00Z').getTime();

      const updates = [
        // First session (ignored)
        { clock: 1, createdAt: new Date(baseTime).toISOString(), userId: 'user-1', userName: 'Alice' },
        // Gap > 5 minutes
        // Second session - Alice and Bob editing together
        { clock: 2, createdAt: new Date(baseTime + DEFAULT_INACTIVITY_THRESHOLD + 1000).toISOString(), userId: 'user-1', userName: 'Alice' },
        { clock: 3, createdAt: new Date(baseTime + DEFAULT_INACTIVITY_THRESHOLD + 2000).toISOString(), userId: 'user-2', userName: 'Bob' },
        { clock: 4, createdAt: new Date(baseTime + DEFAULT_INACTIVITY_THRESHOLD + 3000).toISOString(), userId: 'user-1', userName: 'Alice' },
      ];

      const authors = getCurrentSessionAuthors(updates);

      // Should return both Alice and Bob from last session
      expect(authors).toHaveLength(2);
      const names = authors.map(a => a.name).sort();
      expect(names).toEqual(['Alice', 'Bob']);
    });

    test('distinguishes user from agent in same session', () => {
      const baseTime = new Date('2024-01-01T10:00:00Z').getTime();

      const updates = [
        { clock: 1, createdAt: new Date(baseTime).toISOString(), userId: 'user-1', userName: 'Sam' },
        { clock: 2, createdAt: new Date(baseTime + 1000).toISOString(), userId: 'user-1', userName: 'Sam', agentName: 'Claude' },
      ];

      const authors = getCurrentSessionAuthors(updates);

      // Should have both Sam (human) and Claude (agent) as separate authors
      expect(authors).toHaveLength(2);
      const humanAuthor = authors.find(a => !a.isAgent);
      const agentAuthor = authors.find(a => a.isAgent);
      expect(humanAuthor.name).toBe('Sam');
      expect(agentAuthor.name).toBe('Claude (Sam)');
    });
  });

  // Feature 023 US4 (T016): the timeline is O(rows) — it filters the persisted
  // `meaningful` flag and never replays document content.
  describe('getVersionTimeline is O(rows) (023 US4)', () => {
    const baseTime = new Date('2026-07-19T12:00:00Z').getTime();
    // Rows spaced 1s apart => one auto-version (well under the 5-min threshold).
    const row = (clock, meaningful, minutesApart = 0) => ({
      clock,
      createdAt: new Date(baseTime + clock * 1000 + minutesApart * 60000).toISOString(),
      userId: 'user-1',
      userName: 'Sam',
      userEmail: 'sam@test.com',
      userPicture: null,
      agentName: null,
      onBehalfOf: null,
      meaningful,
    });

    function mockPersistence(rows) {
      return {
        getUpdatesWithUsers: jest.fn(async () => rows),
        getNamedVersions: jest.fn(async () => []),
        // These would indicate a per-update content replay — they MUST NOT be called.
        getYDocAtClock: jest.fn(async () => new Y.Doc()),
        getUpdatesInRange: jest.fn(async () => []),
      };
    }

    test('filters meaningful flags with ZERO content replay; totalEdits = filtered count', async () => {
      const rows = [
        row(0, true), row(1, false), row(2, true), row(3, false), row(4, true),
      ];
      const p = mockPersistence(rows);
      const timeline = await getVersionTimeline(p, 'doc-1');

      // No per-update replay/serialization occurred.
      expect(p.getYDocAtClock).not.toHaveBeenCalled();
      expect(p.getUpdatesInRange).not.toHaveBeenCalled();

      // Only the 3 meaningful updates count.
      expect(timeline.totalEdits).toBe(3);
      expect(timeline.versions.length).toBeGreaterThan(0);
      // The version's end clock is the last meaningful clock (4), not 3 (noise).
      expect(timeline.versions[0].clockEnd).toBe(4);
    });

    test('NULL (unknown) rows appear as meaningful (fail-visible, D-3)', async () => {
      const rows = [row(0, true), row(1, null), row(2, false)];
      const p = mockPersistence(rows);
      const timeline = await getVersionTimeline(p, 'doc-1');
      // clocks 0 (true) and 1 (null=meaningful) count; 2 (false) does not.
      expect(timeline.totalEdits).toBe(2);
    });

    test('an all-noise document produces no phantom version', async () => {
      const rows = [row(0, false), row(1, false)];
      const p = mockPersistence(rows);
      const timeline = await getVersionTimeline(p, 'doc-1');
      expect(timeline.versions).toEqual([]);
      expect(timeline.totalEdits).toBe(0);
      expect(p.getYDocAtClock).not.toHaveBeenCalled();
    });
  });

  describe('restoreVersion', () => {
    test('restores document to previous version content', async () => {
      // Create a mock persistence layer
      const updates = [];
      let clock = 0;

      const mockPersistence = {
        storeUpdate: jest.fn(async (docGuid, update, userId) => {
          clock++;
          updates.push({ clock, update: new Uint8Array(update), userId });
          return clock;
        }),
        getYDoc: jest.fn(async (docGuid) => {
          const doc = new Y.Doc();
          for (const { update } of updates) {
            Y.applyUpdate(doc, update);
          }
          return doc;
        }),
        getUpdatesWithUsers: jest.fn(async (docGuid) => {
          return updates.map(u => ({
            clock: u.clock,
            createdAt: new Date().toISOString(),
            userId: u.userId,
            userName: 'Test User',
          }));
        }),
        getVersionById: jest.fn(),
        getYDocAtClock: jest.fn(async (docGuid, targetClock) => {
          const doc = new Y.Doc();
          for (const { update, clock: updateClock } of updates) {
            if (updateClock <= targetClock) {
              Y.applyUpdate(doc, update);
            }
          }
          return doc;
        }),
      };

      // Helper to get text content from doc
      const getText = (doc) => {
        const fragment = doc.getXmlFragment('default');
        let text = '';

        const extractText = (item) => {
          if (item instanceof Y.XmlText) {
            return item.toString();
          } else if (item instanceof Y.XmlElement) {
            let result = '';
            for (let i = 0; i < item.length; i++) {
              result += extractText(item.get(i));
            }
            return result;
          }
          return '';
        };

        for (let i = 0; i < fragment.length; i++) {
          const element = fragment.get(i);
          text += extractText(element);
        }

        return text;
      };

      // Helper to set text content
      const setText = (doc, text) => {
        const fragment = doc.getXmlFragment('default');
        doc.transact(() => {
          // Clear existing content
          while (fragment.length > 0) {
            fragment.delete(0, fragment.length);
          }
          // Create a paragraph with text
          const paragraph = new Y.XmlElement('paragraph');
          const textContent = new Y.XmlText();
          textContent.insert(0, text);
          paragraph.insert(0, [textContent]);
          fragment.insert(0, [paragraph]);
        });
      };

      // Version 1: "Initial content"
      const doc1 = new Y.Doc();
      setText(doc1, 'Initial content');
      const update1 = Y.encodeStateAsUpdate(doc1);
      await mockPersistence.storeUpdate('test-doc', update1, 'user-1');

      // Version 2: "Second version"
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, update1);
      setText(doc2, 'Second version');
      const stateVector1 = Y.encodeStateVector(doc1);
      const update2 = Y.encodeStateAsUpdate(doc2, stateVector1);
      await mockPersistence.storeUpdate('test-doc', update2, 'user-1');

      // Version 3: "Final version"
      const doc3 = new Y.Doc();
      Y.applyUpdate(doc3, update1);
      Y.applyUpdate(doc3, update2);
      setText(doc3, 'Final version');
      const stateVector2 = Y.encodeStateVector(doc2);
      const update3 = Y.encodeStateAsUpdate(doc3, stateVector2);
      await mockPersistence.storeUpdate('test-doc', update3, 'user-1');

      // Current doc should have "Final version"
      const currentDoc = await mockPersistence.getYDoc('test-doc');
      expect(getText(currentDoc)).toBe('Final version');

      // Now restore to version 1 (clock 1)
      await restoreVersion(mockPersistence, 'test-doc', '1', 'user-1');

      // Get the document after restore
      const restoredDoc = await mockPersistence.getYDoc('test-doc');
      const restoredText = getText(restoredDoc);

      // This should be "Initial content", not "Final version"
      expect(restoredText).toBe('Initial content');
    });

    test('applies restore update to in-memory document (would have failed before fix)', async () => {
      // This test verifies that the restore update is applied to the in-memory document
      // This would have failed before the fix because restore only persisted to DB
      const updates = [];
      let clock = 0;

      const mockPersistence = {
        storeUpdate: jest.fn(async (docGuid, update, userId) => {
          clock++;
          updates.push({ clock, update: new Uint8Array(update), userId });
          return clock;
        }),
        getYDoc: jest.fn(async (docGuid) => {
          const doc = new Y.Doc();
          for (const { update } of updates) {
            Y.applyUpdate(doc, update);
          }
          return doc;
        }),
        getUpdatesWithUsers: jest.fn(async (docGuid) => {
          return updates.map(u => ({
            clock: u.clock,
            createdAt: new Date().toISOString(),
            userId: u.userId,
            userName: 'Test User',
          }));
        }),
        getVersionById: jest.fn(),
        getYDocAtClock: jest.fn(async (docGuid, targetClock) => {
          const doc = new Y.Doc();
          for (const { update, clock: updateClock } of updates) {
            if (updateClock <= targetClock) {
              Y.applyUpdate(doc, update);
            }
          }
          return doc;
        }),
      };

      // Helper to get text content from doc
      const getText = (doc) => {
        const fragment = doc.getXmlFragment('default');
        let text = '';

        const extractText = (item) => {
          if (item instanceof Y.XmlText) {
            return item.toString();
          } else if (item instanceof Y.XmlElement) {
            let result = '';
            for (let i = 0; i < item.length; i++) {
              result += extractText(item.get(i));
            }
            return result;
          }
          return '';
        };

        for (let i = 0; i < fragment.length; i++) {
          const element = fragment.get(i);
          text += extractText(element);
        }

        return text;
      };

      // Helper to set text content
      const setText = (doc, text) => {
        const fragment = doc.getXmlFragment('default');
        doc.transact(() => {
          // Clear existing content
          while (fragment.length > 0) {
            fragment.delete(0, fragment.length);
          }
          // Create a paragraph with text
          const paragraph = new Y.XmlElement('paragraph');
          const textContent = new Y.XmlText();
          textContent.insert(0, text);
          paragraph.insert(0, [textContent]);
          fragment.insert(0, [paragraph]);
        });
      };

      // Set up document versions
      // Version 1: "Original content"
      const doc1 = new Y.Doc();
      setText(doc1, 'Original content');
      const update1 = Y.encodeStateAsUpdate(doc1);
      await mockPersistence.storeUpdate('test-doc', update1, 'user-1');

      // Version 2: "Modified content"
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, update1);
      setText(doc2, 'Modified content');
      const stateVector1 = Y.encodeStateVector(doc1);
      const update2 = Y.encodeStateAsUpdate(doc2, stateVector1);
      await mockPersistence.storeUpdate('test-doc', update2, 'user-1');

      // Create an in-memory document that simulates the shared document used by WebSocket clients
      // This document starts with the current state (after both updates)
      const inMemoryDoc = new Y.Doc();
      Y.applyUpdate(inMemoryDoc, update1);
      Y.applyUpdate(inMemoryDoc, update2);

      // Verify in-memory doc has "Modified content" before restore
      expect(getText(inMemoryDoc)).toBe('Modified content');

      // Mock function to get the shared document (simulating documentService.getSharedDoc)
      const getSharedDocFn = (docGuid) => {
        if (docGuid === 'test-doc') {
          return inMemoryDoc;
        }
        return null;
      };

      // Restore to version 1 (clock 1) - this should update the in-memory document
      await restoreVersion(mockPersistence, 'test-doc', '1', 'user-1', { getSharedDoc: getSharedDocFn });

      // Verify that the in-memory document was actually updated with the restored content
      // This is the key assertion - before the fix, this would fail because
      // the restore update wasn't applied to the in-memory document
      expect(getText(inMemoryDoc)).toBe('Original content');

      // Also verify the database has the correct content
      const restoredDoc = await mockPersistence.getYDoc('test-doc');
      expect(getText(restoredDoc)).toBe('Original content');
    });

    test('restoring a loaded doc persists exactly ONE new update row (F2 no double-persist)', async () => {
      // Simulates the real path: the shared doc has the bindState persistence
      // listener attached, which calls storeUpdate for any parseable origin.
      // restoreVersion stores the delta explicitly and then applies it to the
      // live doc; the ORIGIN_RESTORE sentinel must make the listener SKIP it, so
      // the restore contributes exactly one row (not two at different clocks).
      const { parseOrigin } = require('../origin');

      const updates = [];
      let clock = 0;

      const mockPersistence = {
        storeUpdate: jest.fn(async (docGuid, update, userId, agentName) => {
          clock++;
          updates.push({ clock, update: new Uint8Array(update), userId, agentName });
          return clock;
        }),
        getYDoc: jest.fn(async () => {
          const doc = new Y.Doc();
          for (const { update } of updates) Y.applyUpdate(doc, update);
          return doc;
        }),
        getUpdatesWithUsers: jest.fn(async () => updates.map(u => ({
          clock: u.clock, createdAt: new Date().toISOString(), userId: u.userId, userName: 'Test User',
        }))),
        getVersionById: jest.fn(),
        getYDocAtClock: jest.fn(async (docGuid, targetClock) => {
          const doc = new Y.Doc();
          for (const { update, clock: c } of updates) if (c <= targetClock) Y.applyUpdate(doc, update);
          return doc;
        }),
      };

      const setText = (doc, text) => {
        const fragment = doc.getXmlFragment('default');
        doc.transact(() => {
          while (fragment.length > 0) fragment.delete(0, fragment.length);
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, text);
          p.insert(0, [t]);
          fragment.insert(0, [p]);
        });
      };
      const getText = (doc) => {
        const fragment = doc.getXmlFragment('default');
        let text = '';
        for (let i = 0; i < fragment.length; i++) {
          const el = fragment.get(i);
          for (let j = 0; j < el.length; j++) {
            const c = el.get(j);
            if (c instanceof Y.XmlText) text += c.toString();
          }
        }
        return text;
      };

      // Two stored versions.
      const doc1 = new Y.Doc();
      setText(doc1, 'Original content');
      const update1 = Y.encodeStateAsUpdate(doc1);
      await mockPersistence.storeUpdate('test-doc', update1, 'user-1', null);

      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, update1);
      setText(doc2, 'Modified content');
      const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
      await mockPersistence.storeUpdate('test-doc', update2, 'user-1', null);

      // In-memory shared doc with the bindState-style persistence listener.
      const inMemoryDoc = new Y.Doc();
      Y.applyUpdate(inMemoryDoc, update1);
      Y.applyUpdate(inMemoryDoc, update2);
      inMemoryDoc.on('update', (update, origin) => {
        const parsed = parseOrigin(origin);
        if (!parsed) return; // sentinel origins (incl. ORIGIN_RESTORE) skip persistence
        mockPersistence.storeUpdate('test-doc', update, parsed.userId, parsed.agentName);
      });

      const storeCallsBefore = mockPersistence.storeUpdate.mock.calls.length; // 2 seed writes

      const getSharedDocFn = (g) => (g === 'test-doc' ? inMemoryDoc : null);
      await restoreVersion(mockPersistence, 'test-doc', '1', 'user-1', { getSharedDoc: getSharedDocFn });

      // Exactly ONE additional storeUpdate for the restore (the explicit store),
      // not two (would be the listener re-persisting the live-doc apply).
      const restoreStoreCalls = mockPersistence.storeUpdate.mock.calls.length - storeCallsBefore;
      expect(restoreStoreCalls).toBe(1);

      // And the live doc actually reflects the restore.
      expect(getText(inMemoryDoc)).toBe('Original content');
    });

    test('preserves text marks (bold, italic, strike) when restoring', async () => {
      // Test that marks like strikethrough, bold, italic are preserved
      const updates = [];
      let clock = 0;

      const mockPersistence = {
        storeUpdate: jest.fn(async (docGuid, update, userId) => {
          clock++;
          updates.push({ clock, update: new Uint8Array(update), userId });
          return clock;
        }),
        getYDoc: jest.fn(async (docGuid) => {
          const doc = new Y.Doc();
          for (const { update } of updates) {
            Y.applyUpdate(doc, update);
          }
          return doc;
        }),
        getUpdatesWithUsers: jest.fn(async (docGuid) => {
          return updates.map(u => ({
            clock: u.clock,
            createdAt: new Date().toISOString(),
            userId: u.userId,
            userName: 'Test User',
          }));
        }),
        getVersionById: jest.fn(),
        getYDocAtClock: jest.fn(async (docGuid, targetClock) => {
          const doc = new Y.Doc();
          for (const { update, clock: updateClock } of updates) {
            if (updateClock <= targetClock) {
              Y.applyUpdate(doc, update);
            }
          }
          return doc;
        }),
      };

      // Helper to create a paragraph with formatted text
      const setFormattedText = (doc, segments) => {
        const fragment = doc.getXmlFragment('default');
        doc.transact(() => {
          // Clear existing content
          while (fragment.length > 0) {
            fragment.delete(0, fragment.length);
          }
          // Create a paragraph with formatted text segments
          const paragraph = new Y.XmlElement('paragraph');
          const textElements = [];

          for (const seg of segments) {
            const textContent = new Y.XmlText();
            textContent.insert(0, seg.text, seg.attrs);
            textElements.push(textContent);
          }

          paragraph.insert(0, textElements);
          fragment.insert(0, [paragraph]);
        });
      };

      // Helper to get marks from text
      const getMarks = (doc) => {
        const fragment = doc.getXmlFragment('default');
        const marks = [];

        for (let i = 0; i < fragment.length; i++) {
          const element = fragment.get(i);
          if (element instanceof Y.XmlElement) {
            for (let j = 0; j < element.length; j++) {
              const child = element.get(j);
              if (child instanceof Y.XmlText) {
                const delta = child.toDelta();
                for (const op of delta) {
                  if (op.attributes) {
                    marks.push({ text: op.insert, attrs: op.attributes });
                  } else {
                    marks.push({ text: op.insert, attrs: {} });
                  }
                }
              }
            }
          }
        }

        return marks;
      };

      // Version 1: Text with strikethrough, bold, and italic
      const doc1 = new Y.Doc();
      setFormattedText(doc1, [
        { text: 'Strikethrough text', attrs: { strike: true } },
        { text: ' normal ', attrs: {} },
        { text: 'bold', attrs: { bold: true } },
        { text: ' and ', attrs: {} },
        { text: 'italic', attrs: { italic: true } },
      ]);
      const update1 = Y.encodeStateAsUpdate(doc1);
      await mockPersistence.storeUpdate('test-doc', update1, 'user-1');

      // Version 2: Replace with plain text (loses marks)
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, update1);
      setFormattedText(doc2, [
        { text: 'Plain text only', attrs: {} },
      ]);
      const stateVector1 = Y.encodeStateVector(doc1);
      const update2 = Y.encodeStateAsUpdate(doc2, stateVector1);
      await mockPersistence.storeUpdate('test-doc', update2, 'user-1');

      // Current doc should have plain text only
      const currentDoc = await mockPersistence.getYDoc('test-doc');
      const currentMarks = getMarks(currentDoc);
      expect(currentMarks).toHaveLength(1);
      expect(currentMarks[0].text).toBe('Plain text only');
      expect(currentMarks[0].attrs).toEqual({});

      // Now restore to version 1 (with formatting)
      await restoreVersion(mockPersistence, 'test-doc', '1', 'user-1');

      // Get the document after restore
      const restoredDoc = await mockPersistence.getYDoc('test-doc');
      const restoredMarks = getMarks(restoredDoc);

      // Verify all marks are preserved
      expect(restoredMarks).toHaveLength(5);
      expect(restoredMarks[0]).toEqual({ text: 'Strikethrough text', attrs: { strike: true } });
      expect(restoredMarks[1]).toEqual({ text: ' normal ', attrs: {} });
      expect(restoredMarks[2]).toEqual({ text: 'bold', attrs: { bold: true } });
      expect(restoredMarks[3]).toEqual({ text: ' and ', attrs: {} });
      expect(restoredMarks[4]).toEqual({ text: 'italic', attrs: { italic: true } });
    });

    test('preserves inline marks in single XmlText (real TipTap structure)', async () => {
      // Real TipTap documents have ONE XmlText per paragraph with inline marks
      // This tests the actual document structure, not multiple XmlText elements
      const updates = [];
      let clock = 0;

      const mockPersistence = {
        storeUpdate: jest.fn(async (docGuid, update, userId) => {
          clock++;
          updates.push({ clock, update: new Uint8Array(update), userId });
          return clock;
        }),
        getYDoc: jest.fn(async (docGuid) => {
          const doc = new Y.Doc();
          for (const { update } of updates) {
            Y.applyUpdate(doc, update);
          }
          return doc;
        }),
        getUpdatesWithUsers: jest.fn(async (docGuid) => {
          return updates.map(u => ({
            clock: u.clock,
            createdAt: new Date().toISOString(),
            userId: u.userId,
            userName: 'Test User',
          }));
        }),
        getVersionById: jest.fn(),
        getYDocAtClock: jest.fn(async (docGuid, targetClock) => {
          const doc = new Y.Doc();
          for (const { update, clock: updateClock } of updates) {
            if (updateClock <= targetClock) {
              Y.applyUpdate(doc, update);
            }
          }
          return doc;
        }),
      };

      // Helper to create a paragraph with inline marks in a SINGLE XmlText
      // This is how TipTap actually structures documents
      const setInlineMarkedText = (doc, segments) => {
        const fragment = doc.getXmlFragment('default');
        doc.transact(() => {
          while (fragment.length > 0) {
            fragment.delete(0, fragment.length);
          }
          const paragraph = new Y.XmlElement('paragraph');
          // Create ONE XmlText with multiple inline marks via delta operations
          const textContent = new Y.XmlText();
          const delta = segments.map(seg => ({
            insert: seg.text,
            attributes: Object.keys(seg.attrs).length > 0 ? seg.attrs : undefined,
          }));
          textContent.applyDelta(delta);
          paragraph.insert(0, [textContent]);
          fragment.insert(0, [paragraph]);
        });
      };

      // Helper to get marks from text
      const getMarks = (doc) => {
        const fragment = doc.getXmlFragment('default');
        const marks = [];
        for (let i = 0; i < fragment.length; i++) {
          const element = fragment.get(i);
          if (element instanceof Y.XmlElement) {
            for (let j = 0; j < element.length; j++) {
              const child = element.get(j);
              if (child instanceof Y.XmlText) {
                const delta = child.toDelta();
                for (const op of delta) {
                  marks.push({ text: op.insert, attrs: op.attributes || {} });
                }
              }
            }
          }
        }
        return marks;
      };

      // Version 1: "Normal text " + "link" (with link attr) + " more text"
      const doc1 = new Y.Doc();
      setInlineMarkedText(doc1, [
        { text: 'Check out ', attrs: {} },
        { text: 'this link', attrs: { link: 'https://example.com' } },
        { text: ' for more info.', attrs: {} },
      ]);
      const update1 = Y.encodeStateAsUpdate(doc1);
      await mockPersistence.storeUpdate('test-doc', update1, 'user-1');

      // Version 2: Replace with plain text
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, update1);
      setInlineMarkedText(doc2, [
        { text: 'All plain text now', attrs: {} },
      ]);
      const stateVector1 = Y.encodeStateVector(doc1);
      const update2 = Y.encodeStateAsUpdate(doc2, stateVector1);
      await mockPersistence.storeUpdate('test-doc', update2, 'user-1');

      // Restore to version 1
      await restoreVersion(mockPersistence, 'test-doc', '1', 'user-1');

      // Verify marks are preserved with correct boundaries
      const restoredDoc = await mockPersistence.getYDoc('test-doc');
      const restoredMarks = getMarks(restoredDoc);

      expect(restoredMarks).toHaveLength(3);
      expect(restoredMarks[0]).toEqual({ text: 'Check out ', attrs: {} });
      expect(restoredMarks[1]).toEqual({ text: 'this link', attrs: { link: 'https://example.com' } });
      expect(restoredMarks[2]).toEqual({ text: ' for more info.', attrs: {} });
    });
  });

  describe('getUpdatesForVersion previousClock (F1 sub-version baseline)', () => {
    // Three sub-groups within one parent version: clocks 1-3, 4-6, 7-9, with
    // >10s (UPDATE_GROUPING_THRESHOLD) timestamp gaps between the groups so
    // grouping splits them into three ascending sub-versions.
    const baseTime = new Date('2024-01-01T10:00:00Z').getTime();
    const mkUpdate = (clock, offsetMs) => ({
      clock,
      createdAt: new Date(baseTime + offsetMs).toISOString(),
      userId: 'user-1',
      userName: 'Alice',
      userEmail: 'alice@example.com',
      userPicture: null,
      agentName: null,
    });

    // Group A: 1,2,3 close together; Group B: 4,5,6 (>10s after A);
    // Group C: 7,8,9 (>10s after B).
    const rangeUpdates = [
      mkUpdate(1, 0),
      mkUpdate(2, 1000),
      mkUpdate(3, 2000),
      mkUpdate(4, 15000),
      mkUpdate(5, 16000),
      mkUpdate(6, 17000),
      mkUpdate(7, 30000),
      mkUpdate(8, 31000),
      mkUpdate(9, 32000),
    ];

    const mockPersistence = {
      getUpdatesInRange: async () => rangeUpdates,
    };

    test('each sub-version baselines against the END of the previous (older) sub-version', async () => {
      const { subversions } = await getUpdatesForVersion(mockPersistence, 'doc', 1, 9);

      // Returned newest-first (post-reverse).
      expect(subversions.map(s => s.clockEnd)).toEqual([9, 6, 3]);

      const byEnd = Object.fromEntries(subversions.map(s => [s.clockEnd, s]));

      // Oldest sub-version (1-3) diffs against clockStart - 1 = 0.
      expect(byEnd[3].clockStart).toBe(1);
      expect(byEnd[3].previousClock).toBe(0);

      // Middle sub-version (4-6) diffs against the previous group's end (3).
      expect(byEnd[6].clockStart).toBe(4);
      expect(byEnd[6].previousClock).toBe(3);

      // Newest sub-version (7-9) diffs against the previous group's end (6).
      expect(byEnd[9].clockStart).toBe(7);
      expect(byEnd[9].previousClock).toBe(6);
    });

    test('previousClock is monotonic and never points forward past its own group', async () => {
      const { subversions } = await getUpdatesForVersion(mockPersistence, 'doc', 1, 9);
      for (const sv of subversions) {
        // A baseline must precede the group it is a baseline for (no inversion).
        expect(sv.previousClock).toBeLessThan(sv.clockStart);
      }
    });

    test('returns total and hasMore so the drill-down route can forward them (F5)', async () => {
      // Three sub-groups, limit 2 => two returned, total 3, hasMore true.
      const { subversions, total, hasMore } = await getUpdatesForVersion(mockPersistence, 'doc', 1, 9, 2);
      expect(subversions).toHaveLength(2);
      expect(total).toBe(3);
      expect(hasMore).toBe(true);

      // Default limit (10) comfortably fits three groups => hasMore false.
      const all = await getUpdatesForVersion(mockPersistence, 'doc', 1, 9);
      expect(all.total).toBe(3);
      expect(all.hasMore).toBe(false);
    });

    test('oldest sub-version reports previousClock -1 when the range starts at clock 0', async () => {
      const zeroStart = {
        getUpdatesInRange: async () => [
          mkUpdate(0, 0),
          mkUpdate(1, 1000),
          mkUpdate(2, 15000),
        ],
      };
      const { subversions } = await getUpdatesForVersion(zeroStart, 'doc', 0, 2);
      const oldest = subversions[subversions.length - 1];
      expect(oldest.clockStart).toBe(0);
      expect(oldest.previousClock).toBe(-1);
    });
  });

  describe('getVersionContent validation', () => {
    let mockPersistence;

    beforeEach(() => {
      // Create a mock persistence with updates at specific clocks
      mockPersistence = {
        updates: [
          { clock: 1, userId: 'user-1', userName: 'User 1', createdAt: new Date('2024-01-01T10:00:00Z'), data: null },
          { clock: 5, userId: 'user-1', userName: 'User 1', createdAt: new Date('2024-01-01T10:01:00Z'), data: null },
          { clock: 10, userId: 'user-1', userName: 'User 1', createdAt: new Date('2024-01-01T10:02:00Z'), data: null },
          { clock: 15, userId: 'user-1', userName: 'User 1', createdAt: new Date('2024-01-01T10:03:00Z'), data: null },
        ],
        getUpdatesWithUsers: async (docGuid) => {
          return mockPersistence.updates;
        },
        getYDocAtClock: async (docGuid, clock) => {
          // Return a doc with content based on clock
          const doc = new Y.Doc();
          const fragment = doc.get('default', Y.XmlFragment);
          const paragraph = new Y.XmlElement('paragraph');
          const text = new Y.XmlText();
          text.insert(0, `Content at clock ${clock}`);
          paragraph.insert(0, [text]);
          fragment.insert(0, [paragraph]);
          return doc;
        },
      };
    });

    test('rejects version ID with clock higher than max', async () => {
      await expect(
        getVersionContent(mockPersistence, 'test-doc', '999')
      ).rejects.toThrow('out of range');
    });

    test('rejects version ID with clock lower than min', async () => {
      await expect(
        getVersionContent(mockPersistence, 'test-doc', '0')
      ).rejects.toThrow('out of range');
    });

    test('accepts valid clock number within range', async () => {
      const result = await getVersionContent(mockPersistence, 'test-doc', '10');
      expect(result).toHaveProperty('content');
      expect(result.content).toBeDefined();
    });

    test('accepts any clock in range (not just exact)', async () => {
      // Clock 7 doesn't exist exactly (we have 1, 5, 10, 15) but is in range
      const result = await getVersionContent(mockPersistence, 'test-doc', '7');
      expect(result).toHaveProperty('content');
      expect(result.content).toBeDefined();
    });

    test('rejects document with no history', async () => {
      mockPersistence.getUpdatesWithUsers = async () => [];

      await expect(
        getVersionContent(mockPersistence, 'test-doc', '10')
      ).rejects.toThrow('Document has no version history');
    });

    test('error message shows range for out-of-bounds clock', async () => {
      await expect(
        getVersionContent(mockPersistence, 'test-doc', '999')
      ).rejects.toThrow(/out of range 1-15/);
    });

    // SECURITY regression (review F1): a named version UUID must be scoped to
    // docGuid. Without the guard, read_document({docGuid: A, versionId: <B's>})
    // (and restore/compare, which call this) leak another user's doc content.
    test('named version whose doc_id differs from docGuid is rejected (F1 cross-doc leak)', async () => {
      const victimVersionId = '11111111-2222-3333-4444-555555555555';
      // Feature 023 US3: named versions are pure labels (no snapshot_data). The
      // doc-scope guard rejects a foreign doc_id before ANY log replay.
      mockPersistence.getVersionById = async (id) => ({
        id, doc_id: 'victim-doc-B', // belongs to a DIFFERENT document
        name: 'B secret', clock_start: 1, clock_end: 5,
        created_at: new Date(),
      });
      await expect(
        getVersionContent(mockPersistence, 'attacker-doc-A', victimVersionId)
      ).rejects.toThrow('Version not found');
    });

    test('named version whose doc_id matches docGuid resolves (F1 positive control)', async () => {
      const ownVersionId = '11111111-2222-3333-4444-555555555555';
      mockPersistence.getVersionById = async (id) => ({
        id, doc_id: 'test-doc', name: 'v1', clock_start: 1, clock_end: 10,
        created_at: new Date(), // label-only; content comes from log replay
      });
      const result = await getVersionContent(mockPersistence, 'test-doc', ownVersionId);
      expect(result).toHaveProperty('content');
    });

    // Feature 023 US3 T026 (FR-012, D-6, SC-005): a named version's content is
    // ALWAYS the log replay to clock_end under the gap-tolerant path — never a
    // stored blob. Even a (hypothetical, pre-023) row carrying a DIVERGED
    // snapshot_data is ignored: replay wins.
    test('named version replays to clock_end; a diverged blob is ignored (replay wins)', async () => {
      const ownVersionId = '22222222-3333-4444-5555-666666666666';
      const replaySpy = jest.spyOn(mockPersistence, 'getYDocAtClock');
      mockPersistence.getVersionById = async (id) => ({
        id, doc_id: 'test-doc', name: 'named-at-10', clock_start: 5, clock_end: 10,
        created_at: new Date(),
        // A leftover pre-023 blob whose content diverges from the log. The code
        // must never read it — it is not even a real column after the migration.
        snapshot_data: Buffer.from('STALE DIVERGED CONTENT'),
      });

      const result = await getVersionContent(mockPersistence, 'test-doc', ownVersionId);
      // Content equals the REPLAYED state at clock_end (10), decoded from the
      // update the mock's getYDocAtClock produces — not the diverged blob.
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(result.content));
      expect(doc.get('default', Y.XmlFragment).toString()).toContain('Content at clock 10');
      doc.destroy();
      // getVersionContent now reads the target WITH the gap indicator (F3/FR-009)
      // so a stored-artifact caller can fail closed on a torn read.
      expect(replaySpy).toHaveBeenCalledWith('test-doc', 10, { withGap: true });
      replaySpy.mockRestore();
    });

    // F6: not-found/out-of-range/invalid-format all throw the TYPED
    // VersionNotFoundError, so the routes map them to 404 via instanceof (the
    // old error.message === 'Version not found' equality never matched the
    // descriptive out-of-range message and produced 500s).
    describe('typed VersionNotFoundError (F6)', () => {
      test('out-of-range clock throws VersionNotFoundError', async () => {
        await expect(getVersionContent(mockPersistence, 'test-doc', '999'))
          .rejects.toBeInstanceOf(VersionNotFoundError);
      });

      test('unparseable version id throws VersionNotFoundError', async () => {
        await expect(getVersionContent(mockPersistence, 'test-doc', 'not-a-clock'))
          .rejects.toBeInstanceOf(VersionNotFoundError);
      });

      test('foreign named version throws VersionNotFoundError', async () => {
        const victimVersionId = '11111111-2222-3333-4444-555555555555';
        mockPersistence.getVersionById = async (id) => ({
          id, doc_id: 'other-doc', name: 'x', clock_start: 1, clock_end: 5,
          created_at: new Date(),
        });
        await expect(getVersionContent(mockPersistence, 'test-doc', victimVersionId))
          .rejects.toBeInstanceOf(VersionNotFoundError);
      });
    });
  });

  // F6: getContentAtClock now range-checks (like getVersionContent) so an
  // out-of-range clock 404s instead of returning current content mislabeled.
  describe('getContentAtClock range validation (F6)', () => {
    const mockPersistence = {
      getUpdatesWithUsers: async () => [
        { clock: 5, userId: 'u', userName: 'U', createdAt: new Date('2024-01-01T10:00:00Z') },
        { clock: 10, userId: 'u', userName: 'U', createdAt: new Date('2024-01-01T10:01:00Z') },
      ],
      getUpdatesInRange: async (docGuid, from) => [
        { clock: from, userId: 'u', userName: 'U', createdAt: new Date('2024-01-01T10:00:30Z') },
      ],
      getYDocAtClock: async () => new Y.Doc(),
    };

    test('clock above max throws VersionNotFoundError (not mislabeled current content)', async () => {
      await expect(getContentAtClock(mockPersistence, 'doc', 999))
        .rejects.toBeInstanceOf(VersionNotFoundError);
    });

    test('clock below min throws VersionNotFoundError', async () => {
      await expect(getContentAtClock(mockPersistence, 'doc', 1))
        .rejects.toBeInstanceOf(VersionNotFoundError);
    });

    test('document with no history throws VersionNotFoundError', async () => {
      const empty = { ...mockPersistence, getUpdatesWithUsers: async () => [] };
      await expect(getContentAtClock(empty, 'doc', 5))
        .rejects.toBeInstanceOf(VersionNotFoundError);
    });

    test('in-range clock resolves content', async () => {
      const result = await getContentAtClock(mockPersistence, 'doc', 10);
      expect(result).toHaveProperty('content');
      expect(result.clock).toBe(10);
    });
  });

  // Feature 023 US5 — a restore is a first-class, undoable edit on every surface.
  // DB-backed (real persistence + agent_edits + undo), serial only.
  describe('023 restore integration (US5)', () => {
    let pool, persistence, userId;
    // An MCP agent token's identity — deliberately a name no other identity in
    // the system uses, so the cross-identity scoping assertions below have
    // teeth. (It used to be the literal 'Squire Docs Assistant', which is the
    // chat assistant's own name.)
    const AGENT = 'Test MCP Agent';
    const para = (text) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, text);
      p.insert(0, [t]);
      return p;
    };

    beforeAll(async () => {
      pool = createPool();
      persistence = createPersistence();
      undoService.init(persistence);
      userId = await createTestUser(pool, `restore-023-${Date.now()}@test.com`);
    });

    afterAll(async () => {
      await pool.query('DELETE FROM agent_edits WHERE user_id = $1', [userId]);
      await cleanupTestUser(pool, userId);
      await persistence.destroy();
      await pool.end();
    });

    // Seed clock 0 = "Alpha", clock 1 = "Alpha"+"Beta". Restore to "0" removes Beta.
    async function seedDoc(docGuid) {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment('default');
      let sv = Y.encodeStateVector(doc);
      doc.transact(() => frag.insert(0, [para('Alpha')]));
      await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(doc, sv), userId, null);
      sv = Y.encodeStateVector(doc);
      doc.transact(() => frag.insert(1, [para('Beta')]));
      await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(doc, sv), userId, null);
      doc.destroy();
    }

    // Feature 043 (FR-010, ledger D3): this suite was already compliant; the
    // update-log half now runs through the ONE definition of the convention so
    // there is nothing left to drift from. See server/__tests__/helpers/db.js.
    const cleanupDoc = async (docGuid) => {
      await pool.query('DELETE FROM agent_edits WHERE doc_guid = $1', [docGuid]);
      await cleanupDocRows(pool, docGuid);
    };

    // A human web-UI restore is attributed to the human in the update log and
    // is NOT entered into any identity's undo queue (feature 040's restore-undo
    // capability was cut — see specs/040-restore-undo-attribution/, US1/US6).
    // Reverting a web-UI restore is done by restoring again.
    test('T031: human restore records exactly one update row and NO agent_edits row', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      try {
        const res = await restoreVersion(persistence, docGuid, '0', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: null });
        expect(res.success).toBe(true);
        expect(res.newClock).toBe(2); // exactly one new row (single-persist, FR-024)

        const updates = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
        expect(updates.rows[0].n).toBe(3); // clocks 0,1 + the single restore row

        // The restore is attributed to the HUMAN, not to any agent identity —
        // version history must name the person who pressed the button.
        const logRow = await pool.query('SELECT user_id, agent_name FROM yjs_updates WHERE doc_guid = $1 AND clock = 2', [docGuid]);
        expect(logRow.rows[0].user_id).toBe(userId);
        expect(logRow.rows[0].agent_name).toBeNull();

        // Not an undo target, and in particular no unreachable '' sentinel row.
        const edits = await pool.query('SELECT * FROM agent_edits WHERE doc_guid = $1', [docGuid]);
        expect(edits.rows).toHaveLength(0);

        // The restore actually reverted content to "Alpha" only.
        const replayed = await persistence.getYDoc(docGuid);
        const xml = replayed.getXmlFragment('default').toString();
        expect(xml).toContain('Alpha');
        expect(xml).not.toContain('Beta');
        replayed.destroy();
      } finally {
        await cleanupDoc(docGuid);
      }
    });

    test('T031: agent restore records under the acting agent name', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      try {
        await restoreVersion(persistence, docGuid, '0', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: AGENT });
        const edits = await pool.query('SELECT agent_name FROM agent_edits WHERE doc_guid = $1', [docGuid]);
        expect(edits.rows).toHaveLength(1);
        expect(edits.rows[0].agent_name).toBe(AGENT);
      } finally {
        await cleanupDoc(docGuid);
      }
    });

    test('T031: a recordEdit failure logs but the restore still succeeds', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      const spy = jest.spyOn(editRecords, 'recordEdit').mockRejectedValueOnce(new Error('boom'));
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await restoreVersion(persistence, docGuid, '0', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: null });
        expect(res.success).toBe(true); // restore stands despite the recording failure
        const edits = await pool.query('SELECT count(*)::int AS n FROM agent_edits WHERE doc_guid = $1', [docGuid]);
        expect(edits.rows[0].n).toBe(0); // nothing recorded
      } finally {
        spy.mockRestore();
        errSpy.mockRestore();
        await cleanupDoc(docGuid);
      }
    });

    // Post-merge review F3 (FR-009, D-2): restore is the one stored-artifact path
    // that must fail CLOSED on a torn read — it must not persist the restore row +
    // agent_edits record from content derived from a gapped log.
    test('F3: a torn log makes restore refuse fail-closed — no update row, no agent_edits row', async () => {
      const docGuid = require('crypto').randomUUID();
      const prevRetries = process.env.COLLAB_READ_GAP_RETRIES;
      const prevDelays = process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS;
      process.env.COLLAB_READ_GAP_RETRIES = '1';
      process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '10,10';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Build a causally-chained set of real updates, then insert them with a
        // gap (clocks 0,1,3 — clock 2 withheld) so the CURRENT-state read is torn.
        const doc = new Y.Doc();
        const frag = doc.getXmlFragment('default');
        const updates = [];
        for (let i = 0; i < 4; i++) {
          const sv = Y.encodeStateVector(doc);
          doc.transact(() => frag.insert(frag.length, [para(`seg-${i}`)]));
          updates.push(Y.encodeStateAsUpdate(doc, sv));
        }
        doc.destroy();
        for (const [clock, u] of [[0, updates[0]], [1, updates[1]], [3, updates[3]]]) {
          await pool.query(
            'INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id) VALUES ($1, $2, $3, $4)',
            [docGuid, clock, Buffer.from(u), userId]
          );
        }

        // Restore to clock 1 (in range 0..3): the target read (<=1) is contiguous,
        // but the current-state read spans the gap → still gapped after the retry
        // budget → restore fails closed rather than persist a torn artifact.
        await expect(
          restoreVersion(persistence, docGuid, '1', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: null })
        ).rejects.toBeInstanceOf(DocumentSyncingError);

        // Ground truth: nothing was written.
        const rows = await pool.query('SELECT clock FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]);
        expect(rows.rows.map((r) => Number(r.clock))).toEqual([0, 1, 3]); // no restore row appended
        const edits = await pool.query('SELECT count(*)::int AS n FROM agent_edits WHERE doc_guid = $1', [docGuid]);
        expect(edits.rows[0].n).toBe(0); // no agent_edits record
      } finally {
        warnSpy.mockRestore();
        if (prevRetries === undefined) delete process.env.COLLAB_READ_GAP_RETRIES; else process.env.COLLAB_READ_GAP_RETRIES = prevRetries;
        if (prevDelays === undefined) delete process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS; else process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = prevDelays;
        await cleanupDoc(docGuid);
      }
    });

    test('T032: chat Undo inverts a fresh AGENT restore surgically', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      try {
        // Agent restore to "Alpha" (removes Beta), recorded under AGENT identity.
        await restoreVersion(persistence, docGuid, '0', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: AGENT });
        let xml = (await persistence.getYDoc(docGuid)).getXmlFragment('default').toString();
        expect(xml).not.toContain('Beta');

        // Undo the restore under the AGENT identity (LOW: inverted restore uses
        // the acting agent's identity) — Beta comes back, surgically.
        const undo = await undoService.performUndo({ docGuid, userId, agentName: AGENT }, { getSharedDoc: () => null });
        expect(undo.undone).toBe(true);
        xml = (await persistence.getYDoc(docGuid)).getXmlFragment('default').toString();
        expect(xml).toContain('Alpha');
        expect(xml).toContain('Beta'); // the restore was inverted
      } finally {
        await cleanupDoc(docGuid);
      }
    });

    test('T032: a human web-UI restore is not recorded at all, and no agent undo targets it (D-4 scoping)', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      try {
        await restoreVersion(persistence, docGuid, '0', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: null });
        // No edit record of any identity — not the agent's, not a '' sentinel.
        const edits = await pool.query("SELECT agent_name FROM agent_edits WHERE doc_guid = $1", [docGuid]);
        expect(edits.rows).toHaveLength(0);
        // So an AGENT-identity undo finds nothing to invert (016 identity scoping).
        const undo = await undoService.performUndo({ docGuid, userId, agentName: AGENT }, { getSharedDoc: () => null });
        expect(undo.undone).toBe(false);
      } finally {
        await cleanupDoc(docGuid);
      }
    });

    test('T033: broadcast — loaded doc applies ORIGIN_RESTORE and fans out without re-persist', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      try {
        // A live doc reached via getSharedDoc, no attached redis handler.
        const liveDoc = await persistence.getYDoc(docGuid);
        const pubSub = { isEnabled: () => true, publishUpdate: jest.fn() };
        const before = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);

        await restoreVersion(persistence, docGuid, '0', userId, { getSharedDoc: (g) => (g === docGuid ? liveDoc : null), redisPubSub: pubSub, agentName: null });

        // Applied to the live doc (content reverted in memory).
        expect(liveDoc.getXmlFragment('default').toString()).not.toContain('Beta');
        // No attached handler => published explicitly, exactly once.
        expect(pubSub.publishUpdate).toHaveBeenCalledTimes(1);
        expect(pubSub.publishUpdate.mock.calls[0][0]).toBe(docGuid);
        // No double-persist: only the single restore row was added.
        const after = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
        expect(after.rows[0].n).toBe(before.rows[0].n + 1);
        liveDoc.destroy();
      } finally {
        await cleanupDoc(docGuid);
      }
    });

    test('T033: broadcast — not loaded + Redis => publishUpdate; neither => observable warn', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      try {
        // Not loaded here, Redis enabled => fan out via publishUpdate.
        const pubSub = { isEnabled: () => true, publishUpdate: jest.fn() };
        await restoreVersion(persistence, docGuid, '0', userId, { getSharedDoc: () => null, redisPubSub: pubSub, agentName: null });
        expect(pubSub.publishUpdate).toHaveBeenCalledTimes(1);

        // Neither a live doc nor Redis => observable warn, never silent.
        await seedDoc(docGuid); // add more edits so there is something to restore again
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          await restoreVersion(persistence, docGuid, '0', userId, { getSharedDoc: () => null, redisPubSub: { isEnabled: () => false, publishUpdate: jest.fn() }, agentName: null });
          expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('no delivery path'))).toBe(true);
        } finally {
          warnSpy.mockRestore();
        }
      } finally {
        await cleanupDoc(docGuid);
      }
    });

    test('T034: both surfaces converge — equivalent inputs differ only in identity; bad version throws typed error', async () => {
      const docA = require('crypto').randomUUID();
      const docB = require('crypto').randomUUID();
      await seedDoc(docA);
      await seedDoc(docB);
      try {
        // REST-equivalent (human, agentName null) and MCP-equivalent
        // (agentName AGENT) through the SAME core produce the same result shape
        // and the same update-log effect.
        const rest = await restoreVersion(persistence, docA, '0', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: null });
        const mcp = await restoreVersion(persistence, docB, '0', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: AGENT });
        expect(Object.keys(rest).sort()).toEqual(Object.keys(mcp).sort());
        expect(rest.newClock).toBe(mcp.newClock);

        // Where they differ is the undo queue: only the agent restore is an
        // undoable edit record. A human restore is reverted by restoring again.
        const eA = await pool.query('SELECT agent_name, undo_target_clocks FROM agent_edits WHERE doc_guid = $1', [docA]);
        const eB = await pool.query('SELECT agent_name, undo_target_clocks FROM agent_edits WHERE doc_guid = $1', [docB]);
        expect(eA.rows).toHaveLength(0);
        expect(eB.rows[0].agent_name).toBe(AGENT);
        expect(eB.rows[0].undo_target_clocks).toEqual([mcp.newClock]);

        // A foreign/unknown version id throws the typed VersionNotFoundError on
        // both surfaces (routes/tools map it to 404 / a surfaced error).
        await expect(restoreVersion(persistence, docA, '99999', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: null }))
          .rejects.toBeInstanceOf(VersionNotFoundError);
      } finally {
        await cleanupDoc(docA);
        await cleanupDoc(docB);
      }
    });

    // ── Feature 041 US4 ─────────────────────────────────────────────────────

    test('041 FR-012: a SHORT-TAIL target read makes restore refuse — nothing stored', async () => {
      const docGuid = require('crypto').randomUUID();
      const prevRetries = process.env.COLLAB_READ_GAP_RETRIES;
      const prevDelays = process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS;
      process.env.COLLAB_READ_GAP_RETRIES = '1';
      process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '10,10';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await seedDoc(docGuid); // clocks 0,1

        // The version's own row exists at clock 1... but the read that rebuilds
        // it is made to stop SHORT of it. Before FR-012, `gapped` only meant
        // "interior gap", so this looked complete and restore would happily
        // build its stored artifact from the clock-0 state while labelling it
        // version 1.
        const realGetYDocAtClock = persistence.getYDocAtClock.bind(persistence);
        const spy = jest.spyOn(persistence, 'getYDocAtClock').mockImplementation(
          async (guid, clock, opts = {}) => {
            if (guid === docGuid && opts.expectedTailClock !== undefined) {
              // Same call, but the tail row is not visible yet.
              return realGetYDocAtClock(guid, clock - 1, opts);
            }
            return realGetYDocAtClock(guid, clock, opts);
          }
        );

        try {
          await expect(
            restoreVersion(persistence, docGuid, '1', userId, { getSharedDoc: () => null, redisPubSub: null, agentName: null })
          ).rejects.toBeInstanceOf(DocumentSyncingError);
        } finally {
          spy.mockRestore();
        }

        const rows = await pool.query('SELECT clock FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]);
        expect(rows.rows.map(r => Number(r.clock))).toEqual([0, 1]); // no restore row
        const edits = await pool.query('SELECT count(*)::int AS n FROM agent_edits WHERE doc_guid = $1', [docGuid]);
        expect(edits.rows[0].n).toBe(0);
      } finally {
        warnSpy.mockRestore();
        if (prevRetries === undefined) delete process.env.COLLAB_READ_GAP_RETRIES; else process.env.COLLAB_READ_GAP_RETRIES = prevRetries;
        if (prevDelays === undefined) delete process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS; else process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = prevDelays;
        await cleanupDoc(docGuid);
      }
    });

    test('041 FR-012: serving-only reads are unaffected (no expectedTailClock opt-in)', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      const spy = jest.spyOn(persistence, 'getYDocAtClock');
      try {
        // getVersionContent without withGap is the preview/compare path.
        await getVersionContent(persistence, docGuid, '0');
        expect(spy).toHaveBeenCalled();
        for (const call of spy.mock.calls) {
          expect(call[2]?.expectedTailClock).toBeUndefined();
        }
      } finally {
        spy.mockRestore();
        await cleanupDoc(docGuid);
      }
    });

    test('041 FR-011: the stored restore row is the transition applied to the LIVE doc, even under a concurrent edit', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      try {
        // The live doc on this instance, plus an edit that landed AFTER the
        // durable state restore reads from. Before FR-011 the stored row was a
        // delta against that stale read, so it encoded a different transition
        // than the one users actually saw applied.
        // 046: marked live — bound and connected. Restore only computes a
        // stored artifact from the in-memory copy when it is trustworthy.
        const liveDoc = asLiveSharedDoc(await persistence.getYDoc(docGuid));
        liveDoc.transact(() => {
          liveDoc.getXmlFragment('default').insert(2, [para('Gamma')]);
        });

        const pubSub = { isEnabled: () => true, publishUpdate: jest.fn() };
        const before = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);

        const res = await restoreVersion(persistence, docGuid, '0', userId, {
          getSharedDoc: (g) => (g === docGuid ? liveDoc : null),
          redisPubSub: pubSub,
          agentName: null,
        });

        // Exactly one new row (the sentinel origin keeps the persistence
        // listener from writing a second), and one fan-out.
        const after = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
        expect(after.rows[0].n).toBe(before.rows[0].n + 1);
        expect(pubSub.publishUpdate).toHaveBeenCalledTimes(1);

        // The live doc shows the restored content...
        const liveXml = liveDoc.getXmlFragment('default').toString();
        expect(liveXml).toContain('Alpha');
        expect(liveXml).not.toContain('Beta');
        expect(liveXml).not.toContain('Gamma');

        // ...and applying ONLY the stored row on top of the pre-restore live
        // state reproduces exactly that. The row IS the applied transition.
        const stored = await pool.query('SELECT update_data FROM yjs_updates WHERE doc_guid = $1 AND clock = $2', [docGuid, res.newClock]);
        const replay = new Y.Doc();
        Y.applyUpdate(replay, Y.encodeStateAsUpdate(liveDoc));
        Y.applyUpdate(replay, new Uint8Array(stored.rows[0].update_data));
        expect(replay.getXmlFragment('default').toString()).toBe(liveXml);
        replay.destroy();
        liveDoc.destroy();
      } finally {
        await cleanupDoc(docGuid);
      }
    });

    /**
     * Feature 046 (NEW-2a/NEW-2b): finding a doc in the registry is not enough.
     *
     * Both tests replay the STORED ROW on top of the current persisted state,
     * which is what every client and every later reader ends up doing. A restore
     * to version '0' means "Alpha only", so a replay that still contains 'Beta'
     * is a row that lies about the transition it represents — permanently, on
     * every client. Both shapes below produced exactly that before this fix.
     */
    const replayStoredRowOnCurrentState = async (docGuid, newClock) => {
      const current = await persistence.getYDoc(docGuid);
      const stored = await pool.query(
        'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 AND clock = $2',
        [docGuid, newClock]
      );
      const replay = new Y.Doc();
      Y.applyUpdate(replay, Y.encodeStateAsUpdate(current));
      Y.applyUpdate(replay, new Uint8Array(stored.rows[0].update_data));
      const xml = replay.getXmlFragment('default').toString();
      replay.destroy();
      current.destroy();
      return xml;
    };

    test('NEW-2a: a HALF-LOADED live doc is refused — restore falls back to the durable path', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Exactly what a doc created milliseconds ago looks like: in the
        // registry, connected, readable — and EMPTY, because y-websocket does
        // not await bindState. Transacting on it deletes nothing, so the stored
        // row would be the target clone alone, and the in-flight DB load would
        // then merge the old content back in underneath it.
        const halfLoaded = new Y.Doc();
        halfLoaded.conns = new Map([[{ conn: 1 }, new Set()]]);
        expect(halfLoaded._bindComplete).toBeUndefined();
        expect(halfLoaded.getXmlFragment('default').length).toBe(0);

        const res = await restoreVersion(persistence, docGuid, '0', userId, {
          getSharedDoc: (g) => (g === docGuid ? halfLoaded : null),
          redisPubSub: null,
          agentName: null,
        });

        // The half-loaded doc was never transacted on...
        expect(halfLoaded.getXmlFragment('default').toString()).not.toContain('Alpha');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('bind-incomplete'));

        // ...and the stored row is the honest transition to the target version.
        const xml = await replayStoredRowOnCurrentState(docGuid, res.newClock);
        expect(xml).toContain('Alpha');
        expect(xml).not.toContain('Beta');
        // One paragraph — not the old content plus a duplicated restore target.
        expect(xml.match(/<paragraph>/g)).toHaveLength(1);

        halfLoaded.destroy();
      } finally {
        warn.mockRestore();
        await cleanupDoc(docGuid);
      }
    });

    test('NEW-2b: a LEAKED connection-less doc is refused — restore falls back to the durable path', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // A server-created doc: a sync push / agent create / import reached an
        // unopened document through the CREATING getSharedDoc. It got no Redis
        // subscription (that is wired only in the WS connection handler) and
        // nothing evicts it (eviction is y-websocket's closeConn, and it never
        // had a connection), so it is frozen at the state it was born with while
        // the real document moved on. Here: frozen before 'Beta' existed.
        const { content } = await getVersionContent(persistence, docGuid, '0', { withGap: true });
        const leaked = new Y.Doc();
        Y.applyUpdate(leaked, new Uint8Array(content));
        leaked._bindComplete = true;
        leaked.conns = new Map(); // never had one
        expect(leaked.getXmlFragment('default').toString()).not.toContain('Beta');

        const res = await restoreVersion(persistence, docGuid, '0', userId, {
          getSharedDoc: (g) => (g === docGuid ? leaked : null),
          redisPubSub: null,
          agentName: null,
        });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-connections'));

        // Computed against the DURABLE current state, so the row removes 'Beta'.
        // On the live path it would have been a delta against a document that
        // never saw 'Beta', leaving it behind on every client — feature 041's
        // defect back as a standing condition rather than a race.
        const xml = await replayStoredRowOnCurrentState(docGuid, res.newClock);
        expect(xml).toContain('Alpha');
        expect(xml).not.toContain('Beta');
        expect(xml.match(/<paragraph>/g)).toHaveLength(1);

        leaked.destroy();
      } finally {
        warn.mockRestore();
        await cleanupDoc(docGuid);
      }
    });

    // SC-009a: a restore/undo/redo of a document nobody has open must not leave
    // an in-memory document behind. The old creating lookup allocated one per
    // operation and nothing ever evicted it (eviction only happens when the last
    // WebSocket connection closes — and these docs never had one).
    test('041 FR-013: restore/undo/redo of an unloaded document leave the docs registry untouched', async () => {
      const documentService = require('../document-service');
      const docGuid = require('crypto').randomUUID();
      const docs = new Map();
      // Wire the service the way server boot does, with a creating getYDoc that
      // would populate the registry if anything asked for it.
      documentService.init((docName) => {
        let d = docs.get(docName);
        if (!d) { d = new Y.Doc(); docs.set(docName, d); }
        return d;
      }, (name) => (name.startsWith('s/') ? name.slice(2) : name), docs);

      await seedDoc(docGuid);
      try {
        expect(documentService.peekSharedDoc(docGuid)).toBeNull();
        expect(docs.size).toBe(0);

        await restoreVersion(persistence, docGuid, '0', userId, {
          getSharedDoc: documentService.peekSharedDoc,
          redisPubSub: null,
          agentName: AGENT,
        });
        expect(docs.size).toBe(0);

        const undo = await undoService.performUndo({ docGuid, userId, agentName: AGENT });
        expect(undo.undone).toBe(true);
        expect(docs.size).toBe(0);

        const redo = await undoService.performRedo({ docGuid, userId, agentName: AGENT });
        expect(redo.redone).toBe(true);
        expect(docs.size).toBe(0);

        // The creating primitive still creates — this is a probe change, not a
        // change to the write path's contract.
        documentService.getSharedDoc(docGuid);
        expect(docs.size).toBe(1);
      } finally {
        docs.clear();
        documentService.init(null, null, null);
        await cleanupDoc(docGuid);
      }
    });

    // The live path applies the restore to the shared document BEFORE it stores
    // anything, so a terminal store failure leaves a document that visibly moved
    // and a log that says it never did. That divergence is not something restore
    // can paper over — what it must not do is hide it. The rejection reaches the
    // caller (route → 500 + page, MCP → surfaced error), so the user is told the
    // restore failed instead of being shown a success over an unrecorded change.
    test('T024: a terminal storeUpdate rejection on the live path surfaces to the caller and records nothing', async () => {
      const docGuid = require('crypto').randomUUID();
      await seedDoc(docGuid);

      const liveDoc = asLiveSharedDoc(await persistence.getYDoc(docGuid)); // 046: bound + connected
      // y-websocket broadcasts to its clients from a peer 'update' listener, so
      // "did this listener fire" is exactly "did the connected editors see it".
      const broadcastOrigins = [];
      const broadcastListener = (update, origin) => broadcastOrigins.push(origin);
      liveDoc.on('update', broadcastListener);

      const storeSpy = jest.spyOn(persistence, 'storeUpdate')
        .mockRejectedValue(new Error('storage unavailable'));

      try {
        await expect(
          restoreVersion(persistence, docGuid, '0', userId, {
            getSharedDoc: (g) => (g === docGuid ? liveDoc : null),
            redisPubSub: null,
            agentName: AGENT,
          })
        ).rejects.toThrow('storage unavailable');

        // The restore DID apply, and DID reach the live doc's clients.
        expect(broadcastOrigins).toHaveLength(1);
        const liveXml = liveDoc.getXmlFragment('default').toString();
        expect(liveXml).toContain('Alpha');
        expect(liveXml).not.toContain('Beta');

        // Nothing durable was written: no restore row...
        const rows = await pool.query('SELECT clock FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]);
        expect(rows.rows.map(r => Number(r.clock))).toEqual([0, 1]);
        // ...and no agent_edits record for the agent restore whose store failed,
        // so undo never offers to invert an edit that was never logged.
        const edits = await pool.query('SELECT count(*)::int AS n FROM agent_edits WHERE doc_guid = $1', [docGuid]);
        expect(edits.rows[0].n).toBe(0);
      } finally {
        storeSpy.mockRestore();
        liveDoc.off('update', broadcastListener);
        liveDoc.destroy();
        await cleanupDoc(docGuid);
      }
    });

    // PIN: index.js boots a live server on require, so the REST half of that
    // posture — the caller is TOLD, loudly — is pinned by source inspection.
    test('T024: the restore route maps a terminal restore failure to 500 and a page', () => {
      const source = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'index.js'),
        'utf8'
      );
      expect(source).toMatch(
        /console\.error\('Error restoring version:', error\);[\s\S]{0,800}?notifyException\(error, \{ req, source: 'api' \}\);\s*res\.status\(500\)\.json\(\{ error: 'Failed to restore version' \}\);/
      );
    });
  });
});
