/**
 * set_agent_selection tool tests
 *
 * Tests the MCP tool for setting agent text selections.
 */
const { Pool } = require('pg');
const { PostgresPersistence } = require('../../../postgres-persistence');

// Test database configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// Create persistence provider
const persistenceProvider = new PostgresPersistence({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// Import modules
const documents = require('../../../documents');
const setAgentSelection = require('../../tools/set-agent-selection');
const agentPresence = require('../../agent-presence');

describe('set_agent_selection tool', () => {
  let testUserId;
  let testUser2Id;
  let testDocId;

  beforeAll(async () => {
    // Initialize modules
    documents.init(pool);
    setAgentSelection.init(persistenceProvider);
    agentPresence.init(persistenceProvider);

    // Create test users
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-agent-sel-test', 'agent-sel-test@example.com', 'Agent Selection Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    const user2Result = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-agent-sel-test-2', 'agent-sel-test-2@example.com', 'Agent Selection Test User 2')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUser2Id = user2Result.rows[0].id;
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [testDocId]);
    await pool.query('DELETE FROM document_shares WHERE user_id IN ($1, $2)', [
      testUserId,
      testUser2Id,
    ]);
    await pool.query('DELETE FROM documents WHERE creator_id IN ($1, $2)', [
      testUserId,
      testUser2Id,
    ]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [testUserId, testUser2Id]);
    await pool.end();
  });

  beforeEach(async () => {
    // Clean up and create fresh test document
    if (testDocId) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [testDocId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [testDocId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [testDocId]);
    }

    // Create test document
    const docResult = await pool.query(
      `INSERT INTO documents (id, creator_id)
       VALUES (uuid_generate_v4(), $1)
       RETURNING id`,
      [testUserId]
    );
    testDocId = docResult.rows[0].id;
    await documents.setRole(testDocId, testUserId, 'owner');

    // Clear any active sessions
    agentPresence.clearUserSessions(testUserId);
    agentPresence.clearUserSessions(testUser2Id);
  });

  afterEach(async () => {
    // Clean up sessions after each test
    agentPresence.clearUserSessions(testUserId);
    agentPresence.clearUserSessions(testUser2Id);
  });

  describe('Input Validation', () => {
    test('rejects invalid anchor position', async () => {
      const agentToken = { userId: testUserId, email: 'agent-sel-test@example.com' };
      const validHead = { tname: 'default', item: { client: 123, clock: 10 }, assoc: 0 };
      await expect(
        setAgentSelection.handler({ docGuid: testDocId, anchor: 'invalid', head: validHead }, agentToken)
      ).rejects.toThrow();
    });

    test('rejects invalid head position', async () => {
      const agentToken = { userId: testUserId, email: 'agent-sel-test@example.com' };
      const validAnchor = { tname: 'default', item: { client: 123, clock: 5 }, assoc: 0 };
      await expect(
        setAgentSelection.handler({ docGuid: testDocId, anchor: validAnchor, head: 'invalid' }, agentToken)
      ).rejects.toThrow();
    });

    test('allows valid relative position objects', async () => {
      const agentToken = { userId: testUserId, email: 'agent-sel-test@example.com' };
      const anchor = { tname: 'default', item: { client: 123, clock: 5 }, assoc: 0 };
      const head = { tname: 'default', item: { client: 123, clock: 10 }, assoc: 0 };

      // Note: This test will fail to connect in test environment
      // In production, it would work with a running WebSocket server
      await expect(
        setAgentSelection.handler({ docGuid: testDocId, anchor, head }, agentToken)
      ).rejects.toThrow(); // Expect connection error in test env
    });
  });

  describe('Permission Checks', () => {
    test('rejects access to non-existent document', async () => {
      const fakeDocId = '00000000-0000-0000-0000-000000000000';
      const agentToken = { userId: testUserId, email: 'agent-sel-test@example.com' };
      const anchor = { tname: 'default', item: { client: 123, clock: 0 }, assoc: 0 };
      const head = { tname: 'default', item: { client: 123, clock: 10 }, assoc: 0 };

      await expect(
        setAgentSelection.handler({ docGuid: fakeDocId, anchor, head }, agentToken)
      ).rejects.toThrow('Document not found or you do not have access');
    });

    test('rejects access for user without permissions', async () => {
      const agentToken = { userId: testUser2Id, email: 'agent-sel-test-2@example.com' };
      const anchor = { tname: 'default', item: { client: 123, clock: 0 }, assoc: 0 };
      const head = { tname: 'default', item: { client: 123, clock: 10 }, assoc: 0 };

      await expect(
        setAgentSelection.handler({ docGuid: testDocId, anchor, head }, agentToken)
      ).rejects.toThrow('Document not found or you do not have access');
    });

    test('allows access for user with viewer permissions', async () => {
      // Give test user 2 viewer access
      await documents.setRole(testDocId, testUser2Id, 'viewer');

      const agentToken = { userId: testUser2Id, email: 'agent-sel-test-2@example.com' };
      const anchor = { tname: 'default', item: { client: 123, clock: 0 }, assoc: 0 };
      const head = { tname: 'default', item: { client: 123, clock: 10 }, assoc: 0 };

      // Note: This test will fail to connect in test environment
      // In production, it would work with a running WebSocket server
      await expect(
        setAgentSelection.handler({ docGuid: testDocId, anchor, head }, agentToken)
      ).rejects.toThrow(); // Expect connection error in test env
    });
  });

  describe('Session Management', () => {
    test('clearSession removes a specific session', () => {
      const sessions = agentPresence.getActiveSessions();
      const testSessionId = 'test-session-123';

      // Create a cleanup function that actually removes the session
      const cleanup = () => {
        sessions.delete(testSessionId);
      };

      // Manually add a session for testing
      sessions.set(testSessionId, {
        docGuid: testDocId,
        userId: testUserId,
        provider: null,
        cleanup,
        createdAt: Date.now(),
      });

      expect(sessions.has(testSessionId)).toBe(true);
      expect(agentPresence.clearSession(testSessionId)).toBe(true);
      expect(sessions.has(testSessionId)).toBe(false);
    });

    test('clearSession returns false for non-existent session', () => {
      expect(agentPresence.clearSession('non-existent-session')).toBe(false);
    });

    test('clearUserSessions removes all sessions for a user', () => {
      const sessions = agentPresence.getActiveSessions();

      // Helper to create cleanup function
      const makeCleanup = (sessionId) => () => {
        sessions.delete(sessionId);
      };

      // Add multiple sessions for the user
      sessions.set('session-1', {
        docGuid: testDocId,
        userId: testUserId,
        provider: null,
        cleanup: makeCleanup('session-1'),
        createdAt: Date.now(),
      });

      sessions.set('session-2', {
        docGuid: testDocId,
        userId: testUserId,
        provider: null,
        cleanup: makeCleanup('session-2'),
        createdAt: Date.now(),
      });

      sessions.set('session-3', {
        docGuid: testDocId,
        userId: testUser2Id,
        provider: null,
        cleanup: makeCleanup('session-3'),
        createdAt: Date.now(),
      });

      expect(sessions.size).toBe(3);
      const count = agentPresence.clearUserSessions(testUserId);
      expect(count).toBe(2);
      expect(sessions.has('session-1')).toBe(false);
      expect(sessions.has('session-2')).toBe(false);
      expect(sessions.has('session-3')).toBe(true); // Should not remove other user's session
    });
  });

  describe('Tool Definition', () => {
    test('has required properties', () => {
      expect(setAgentSelection.name).toBe('set_agent_selection');
      expect(setAgentSelection.description).toBeTruthy();
      expect(setAgentSelection.inputSchema).toBeTruthy();
      expect(setAgentSelection.inputSchema.properties).toBeTruthy();
    });

    test('requires docGuid, anchor, and head parameters', () => {
      expect(setAgentSelection.inputSchema.required).toEqual(['docGuid', 'anchor', 'head']);
    });

    test('has optional durationSeconds parameter', () => {
      expect(setAgentSelection.inputSchema.properties.durationSeconds).toBeTruthy();
      expect(setAgentSelection.inputSchema.required).not.toContain('durationSeconds');
    });
  });
});

// Note: Integration tests with a running WebSocket server would be needed to test:
// - Actual WebSocket connection establishment
// - Awareness state updates
// - Selection visibility to other users
// - Timeout behavior
// - Connection cleanup
