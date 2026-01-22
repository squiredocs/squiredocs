/**
 * Tests for Agent Presence Manager
 */
const agentPresence = require('../agent-presence');

describe('Agent Presence Manager', () => {
  // Helper to create a mock session and add it to all indexes
  function createMockSession(overrides = {}) {
    const sessions = agentPresence.getActiveSessions();
    const sessionsByKey = agentPresence._sessionsByKey;
    const sessionsByUserId = agentPresence._sessionsByUserId;
    const defaults = {
      sessionId: `test-session-${Date.now()}-${Math.random()}`,
      docGuid: 'test-doc-guid',
      userId: 'test-user-id',
      key: 'test-user-id-test-doc-guid',
      provider: {
        wsconnected: true,
        awareness: { setLocalStateField: jest.fn() },
      },
      cleanup: jest.fn(),
      timeoutId: null,
      createdAt: Date.now(),
      cursor: null,
      initialized: true,
      undoManager: {},
      clipboard: null,
      lastActivityAt: Date.now(),
      highlightQueue: null,
    };
    const session = { ...defaults, ...overrides };
    session.key = `${session.userId}-${session.docGuid}`;

    // Add to all indexes (mirroring what _createSessionCore does)
    sessions.set(session.sessionId, session);
    sessionsByKey.set(session.key, session.sessionId);
    if (!sessionsByUserId.has(session.userId)) {
      sessionsByUserId.set(session.userId, new Set());
    }
    sessionsByUserId.get(session.userId).add(session.sessionId);

    return session;
  }

  // Helper to clean up a mock session from all indexes
  function cleanupMockSession(sessionId) {
    const sessions = agentPresence.getActiveSessions();
    const sessionsByKey = agentPresence._sessionsByKey;
    const sessionsByUserId = agentPresence._sessionsByUserId;

    const session = sessions.get(sessionId);
    if (session) {
      sessions.delete(sessionId);
      sessionsByKey.delete(session.key);
      const userSessions = sessionsByUserId.get(session.userId);
      if (userSessions) {
        userSessions.delete(sessionId);
        if (userSessions.size === 0) {
          sessionsByUserId.delete(session.userId);
        }
      }
    }
  }

  beforeEach(() => {
    // Clear all sessions before each test
    const sessions = agentPresence.getActiveSessions();
    for (const [sessionId] of sessions) {
      agentPresence.clearSession(sessionId);
    }
  });

  describe('module exports', () => {
    test('exports all required functions', () => {
      expect(typeof agentPresence.init).toBe('function');
      expect(typeof agentPresence.getOrCreateSession).toBe('function');
      expect(typeof agentPresence.clearSession).toBe('function');
      expect(typeof agentPresence.clearUserSessions).toBe('function');
      expect(typeof agentPresence.getActiveSessions).toBe('function');
      expect(typeof agentPresence.updateSessionCursor).toBe('function');
      expect(typeof agentPresence.setTemporarySelection).toBe('function');
      expect(typeof agentPresence.clearHighlightQueue).toBe('function');
      expect(typeof agentPresence.queueHighlightSequence).toBe('function');
      expect(typeof agentPresence.getSession).toBe('function');
    });

    test('does not export queueHighlight (removed as dead code)', () => {
      expect(agentPresence.queueHighlight).toBeUndefined();
    });
  });

  describe('setTemporarySelection', () => {
    test('returns false for non-existent session', () => {
      const result = agentPresence.setTemporarySelection(
        'non-existent-session-id',
        { type: null, tname: null, item: null },
        { type: null, tname: null, item: null }
      );

      expect(result).toBe(false);
    });

    test('is exported from the module', () => {
      expect(typeof agentPresence.setTemporarySelection).toBe('function');
    });

    test('setTemporarySelection has 3 required parameters', () => {
      // sessionId, anchor, head are required
      expect(agentPresence.setTemporarySelection.length).toBe(3);
    });
  });

  describe('updateSessionCursor', () => {
    test('returns false for non-existent session', () => {
      const result = agentPresence.updateSessionCursor(
        'non-existent-session-id',
        { type: null, tname: null, item: null },
        { type: null, tname: null, item: null }
      );

      expect(result).toBe(false);
    });

    test('returns true and updates cursor for existing session', () => {
      const session = createMockSession();
      const anchor = { type: 'test', tname: 'test', item: null };
      const head = { type: 'test', tname: 'test', item: null };

      const result = agentPresence.updateSessionCursor(session.sessionId, anchor, head);

      expect(result).toBe(true);
      expect(session.cursor).toEqual({ anchor, head });
      expect(session.provider.awareness.setLocalStateField).toHaveBeenCalledWith('cursor', { anchor, head });

      cleanupMockSession(session.sessionId);
    });
  });

  describe('clearHighlightQueue', () => {
    test('returns 0 for non-existent session', () => {
      const result = agentPresence.clearHighlightQueue('non-existent-session-id');
      expect(result).toBe(0);
    });

    test('returns 0 when session has no highlight queue', () => {
      const session = createMockSession({ highlightQueue: null });

      const result = agentPresence.clearHighlightQueue(session.sessionId);

      expect(result).toBe(0);

      cleanupMockSession(session.sessionId);
    });

    test('clears highlight queue and returns pending count', () => {
      const mockTimeoutId = setTimeout(() => {}, 10000);
      const session = createMockSession({
        highlightQueue: {
          positions: [
            { anchor: {}, head: {} },
            { anchor: {}, head: {} },
            { anchor: {}, head: {} },
            { anchor: {}, head: {} },
            { anchor: {}, head: {} },
          ],
          currentIndex: 2, // 2 processed, 3 pending
          timeoutId: mockTimeoutId,
          isProcessing: true,
        },
      });

      const result = agentPresence.clearHighlightQueue(session.sessionId);

      expect(result).toBe(3); // 5 total - 2 processed = 3 pending
      expect(session.highlightQueue).toBeNull();

      clearTimeout(mockTimeoutId);
      cleanupMockSession(session.sessionId);
    });

    test('cancels pending timeout when clearing queue', () => {
      jest.useFakeTimers();

      const session = createMockSession({
        highlightQueue: {
          positions: [{ anchor: {}, head: {} }],
          currentIndex: 0,
          timeoutId: null,
          isProcessing: false,
        },
      });

      // Manually set a real timeout on the queue
      session.highlightQueue.timeoutId = setTimeout(() => {
        throw new Error('Timeout should have been cleared');
      }, 100);

      agentPresence.clearHighlightQueue(session.sessionId);

      // Advance timers - if timeout wasn't cleared, this would throw
      jest.advanceTimersByTime(200);

      expect(session.highlightQueue).toBeNull();

      jest.useRealTimers();
      cleanupMockSession(session.sessionId);
    });
  });

  describe('queueHighlightSequence', () => {
    test('returns false for non-existent session', () => {
      const result = agentPresence.queueHighlightSequence(
        'non-existent-session-id',
        [{ anchor: {}, head: {} }]
      );
      expect(result).toBe(false);
    });

    test('returns false for empty positions array', () => {
      const session = createMockSession();

      const result = agentPresence.queueHighlightSequence(session.sessionId, []);

      expect(result).toBe(false);

      cleanupMockSession(session.sessionId);
    });

    test('returns false for null positions', () => {
      const session = createMockSession();

      const result = agentPresence.queueHighlightSequence(session.sessionId, null);

      expect(result).toBe(false);

      cleanupMockSession(session.sessionId);
    });

    test('returns true and initializes queue for valid input', () => {
      const session = createMockSession();
      const positions = [
        { anchor: { type: 'a' }, head: { type: 'a' } },
        { anchor: { type: 'b' }, head: { type: 'b' } },
      ];

      const result = agentPresence.queueHighlightSequence(session.sessionId, positions);

      expect(result).toBe(true);
      expect(session.highlightQueue).not.toBeNull();
      expect(session.highlightQueue.positions.length).toBe(2);

      // Clean up - clear the queue to stop processing
      agentPresence.clearHighlightQueue(session.sessionId);
      cleanupMockSession(session.sessionId);
    });
  });

  describe('clearUserSessions', () => {
    test('returns 0 when user has no sessions', () => {
      const result = agentPresence.clearUserSessions('non-existent-user');
      expect(result).toBe(0);
    });

    test('clears all sessions for a user and returns count', () => {
      // Create multiple sessions for the same user
      const userId = 'test-user-multi';
      const session1 = createMockSession({
        sessionId: 'session-1',
        userId,
        docGuid: 'doc-1',
      });
      const session2 = createMockSession({
        sessionId: 'session-2',
        userId,
        docGuid: 'doc-2',
      });
      const session3 = createMockSession({
        sessionId: 'session-3',
        userId,
        docGuid: 'doc-3',
      });

      // Create a session for a different user (should not be cleared)
      const otherSession = createMockSession({
        sessionId: 'other-session',
        userId: 'other-user',
        docGuid: 'doc-other',
      });

      const result = agentPresence.clearUserSessions(userId);

      expect(result).toBe(3);
      expect(session1.cleanup).toHaveBeenCalled();
      expect(session2.cleanup).toHaveBeenCalled();
      expect(session3.cleanup).toHaveBeenCalled();
      expect(otherSession.cleanup).not.toHaveBeenCalled();

      // Clean up the other session
      cleanupMockSession(otherSession.sessionId);
    });
  });

  describe('session reuse with empty documents', () => {
    // This tests the fix for the duplicate H1 heading bug
    // Bug: when cursor was null (empty doc), session wasn't reused, causing duplicates
    // Fix: use 'initialized' flag instead of 'cursor' for session reuse check

    test('session with cursor=null but initialized=true should be found by getSession', () => {
      // Manually create a session that simulates an empty document
      // (cursor is null because there are no blocks to position cursor in)
      const session = createMockSession({
        cursor: null,
        initialized: true,
      });

      // Verify the session can be retrieved
      const retrieved = agentPresence.getSession(session.sessionId);
      expect(retrieved).toBe(session);
      expect(retrieved.cursor).toBeNull();
      expect(retrieved.initialized).toBe(true);

      cleanupMockSession(session.sessionId);
    });

    test('session structure should include initialized flag', () => {
      const session = createMockSession({
        initialized: false,
      });

      const retrieved = agentPresence.getSession(session.sessionId);

      // Verify initialized flag exists and is boolean
      expect(retrieved).toHaveProperty('initialized');
      expect(typeof retrieved.initialized).toBe('boolean');

      cleanupMockSession(session.sessionId);
    });
  });

  describe('getSession', () => {
    test('returns null for non-existent session', () => {
      const result = agentPresence.getSession('non-existent-session-id');
      expect(result).toBeNull();
    });

    test('returns session object for existing session', () => {
      const session = createMockSession();

      const result = agentPresence.getSession(session.sessionId);

      expect(result).toBe(session);

      cleanupMockSession(session.sessionId);
    });
  });

  describe('clearSession', () => {
    test('returns false for non-existent session', () => {
      const result = agentPresence.clearSession('non-existent-session-id');
      expect(result).toBe(false);
    });

    test('returns true and calls cleanup for existing session', () => {
      const session = createMockSession();

      const result = agentPresence.clearSession(session.sessionId);

      expect(result).toBe(true);
      expect(session.cleanup).toHaveBeenCalled();
    });
  });
});
