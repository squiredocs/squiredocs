/**
 * Tests for version-history module
 */
const {
  generateColorFromId,
  groupUpdatesIntoVersions,
  mergeNamedVersions,
  formatTimestamp,
  restoreVersion,
  getVersionContent,
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
  });
});
