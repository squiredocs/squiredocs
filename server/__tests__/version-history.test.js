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
        { clock: 2, createdAt: new Date(baseTime + 60000).toISOString(), userId: 'user-1', userName: 'Alice' }, // 1 min later
        { clock: 3, createdAt: new Date(baseTime + 120000).toISOString(), userId: 'user-2', userName: 'Bob' }, // 2 min later
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
      expect(result[0].id).toBe('auto-5');
      expect(result[1].id).toBe('auto-10');
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

  describe('DEFAULT_INACTIVITY_THRESHOLD', () => {
    test('is 5 minutes in milliseconds', () => {
      expect(DEFAULT_INACTIVITY_THRESHOLD).toBe(5 * 60 * 1000);
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
      await restoreVersion(mockPersistence, 'test-doc', 'auto-1', 'user-1');

      // Get the document after restore
      const restoredDoc = await mockPersistence.getYDoc('test-doc');
      const restoredText = getText(restoredDoc);

      // This should be "Initial content", not "Final version"
      expect(restoredText).toBe('Initial content');
    });
  });
});
