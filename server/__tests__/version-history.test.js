/**
 * Tests for version-history module
 */
const {
  generateColorFromId,
  createAuthor,
  groupUpdatesIntoVersions,
  mergeNamedVersions,
  formatTimestamp,
  restoreVersion,
  getVersionContent,
  getUpdatesForVersion,
  getCurrentSessionAuthors,
  DEFAULT_INACTIVITY_THRESHOLD,
} = require('../version-history');
const Y = require('yjs');

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

    test('handles updates without user info', () => {
      const updates = [
        { clock: 1, createdAt: '2024-01-01T10:00:00Z' }, // No user info
      ];

      const versions = groupUpdatesIntoVersions(updates);

      expect(versions).toHaveLength(1);
      expect(versions[0].authors).toHaveLength(0);
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
      await restoreVersion(mockPersistence, 'test-doc', '1', 'user-1', getSharedDocFn);

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
      await restoreVersion(mockPersistence, 'test-doc', '1', 'user-1', getSharedDocFn);

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
      mockPersistence.getVersionById = async (id) => ({
        id, doc_id: 'victim-doc-B', // belongs to a DIFFERENT document
        name: 'B secret', clock_start: 1, clock_end: 5,
        created_at: new Date(), snapshot_data: Buffer.from('secret B content'),
      });
      await expect(
        getVersionContent(mockPersistence, 'attacker-doc-A', victimVersionId)
      ).rejects.toThrow('Version not found');
    });

    test('named version whose doc_id matches docGuid resolves (F1 positive control)', async () => {
      const ownVersionId = '11111111-2222-3333-4444-555555555555';
      mockPersistence.getVersionById = async (id) => ({
        id, doc_id: 'test-doc', name: 'v1', clock_start: 1, clock_end: 10,
        created_at: new Date(), snapshot_data: null, // fall through to clock rebuild
      });
      const result = await getVersionContent(mockPersistence, 'test-doc', ownVersionId);
      expect(result).toHaveProperty('content');
    });
  });
});
