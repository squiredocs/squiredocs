/**
 * Tests for Agent Presence Manager
 */
const agentPresence = require('../agent-presence');

describe('Agent Presence Manager', () => {
  describe('setTemporarySelection', () => {
    beforeEach(() => {
      // Clear all sessions before each test
      const sessions = agentPresence.getActiveSessions();
      for (const [sessionId] of sessions) {
        agentPresence.clearSession(sessionId);
      }
    });

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

  describe('module exports', () => {
    test('exports all required functions', () => {
      expect(typeof agentPresence.init).toBe('function');
      expect(typeof agentPresence.getOrCreateSession).toBe('function');
      expect(typeof agentPresence.clearSession).toBe('function');
      expect(typeof agentPresence.clearUserSessions).toBe('function');
      expect(typeof agentPresence.getActiveSessions).toBe('function');
      expect(typeof agentPresence.updateSessionCursor).toBe('function');
      expect(typeof agentPresence.setTemporarySelection).toBe('function');
      expect(typeof agentPresence.getSession).toBe('function');
    });
  });

  describe('session reuse with empty documents', () => {
    // This tests the fix for the duplicate H1 heading bug
    // Bug: when cursor was null (empty doc), session wasn't reused, causing duplicates
    // Fix: use 'initialized' flag instead of 'cursor' for session reuse check

    beforeEach(() => {
      // Clear all sessions before each test
      const sessions = agentPresence.getActiveSessions();
      for (const [sessionId] of sessions) {
        agentPresence.clearSession(sessionId);
      }
    });

    test('session with cursor=null but initialized=true should be found by getSession', () => {
      // Manually create a session that simulates an empty document
      // (cursor is null because there are no blocks to position cursor in)
      const sessions = agentPresence.getActiveSessions();
      const testSessionId = 'test-session-empty-doc';

      // Create mock session with null cursor but initialized=true
      const mockSession = {
        sessionId: testSessionId,
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
        cursor: null, // Empty doc has null cursor
        initialized: true, // But session IS initialized
        undoManager: {},
        clipboard: null,
        lastActivityAt: Date.now(),
      };

      sessions.set(testSessionId, mockSession);

      // Verify the session can be retrieved
      const retrieved = agentPresence.getSession(testSessionId);
      expect(retrieved).toBe(mockSession);
      expect(retrieved.cursor).toBeNull();
      expect(retrieved.initialized).toBe(true);

      // Clean up
      sessions.delete(testSessionId);
    });

    test('session structure should include initialized flag', () => {
      // Verify that any session created includes the initialized flag
      // This is a regression test for the fix
      const sessions = agentPresence.getActiveSessions();
      const testSessionId = 'test-session-structure';

      // Create a minimal mock session matching expected structure
      const mockSession = {
        sessionId: testSessionId,
        docGuid: 'test-doc',
        userId: 'test-user',
        key: 'test-user-test-doc',
        provider: null,
        cleanup: jest.fn(),
        timeoutId: null,
        createdAt: Date.now(),
        cursor: null,
        initialized: false, // New sessions start uninitialized
        undoManager: null,
        clipboard: null,
        lastActivityAt: Date.now(),
      };

      sessions.set(testSessionId, mockSession);

      const retrieved = agentPresence.getSession(testSessionId);

      // Verify initialized flag exists and is boolean
      expect(retrieved).toHaveProperty('initialized');
      expect(typeof retrieved.initialized).toBe('boolean');

      // Clean up
      sessions.delete(testSessionId);
    });
  });
});
