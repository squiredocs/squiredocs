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
      expect(typeof agentPresence.setAgentPresence).toBe('function');
      expect(typeof agentPresence.getOrCreateSession).toBe('function');
      expect(typeof agentPresence.clearSession).toBe('function');
      expect(typeof agentPresence.clearUserSessions).toBe('function');
      expect(typeof agentPresence.getActiveSessions).toBe('function');
      expect(typeof agentPresence.updateSessionCursor).toBe('function');
      expect(typeof agentPresence.setTemporarySelection).toBe('function');
      expect(typeof agentPresence.getSession).toBe('function');
    });
  });
});
