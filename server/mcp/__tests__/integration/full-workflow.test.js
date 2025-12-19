/**
 * Full Agent Workflow Integration Tests
 *
 * Tests the complete flow: delegation → token → authentication → tool usage
 */

// Set test secrets
process.env.MCP_JWT_SECRET = 'test-mcp-secret';

// Mock agent presence to avoid WebSocket connections in tests
// Must be before imports due to Jest hoisting
jest.mock('../../agent-presence', () => {
  const Y = require('yjs');
  const { Pool } = require('pg');

  // Create a pool for the mock (will be used to load documents)
  const mockPool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'collab_db',
    user: process.env.DB_USER || process.env.USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  });

  return {
    init: jest.fn(),
    getOrCreateSession: jest.fn(async (docGuid, agentToken, durationSeconds) => {
      // Load the document from database for the test
      const result = await mockPool.query(
        'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
        [docGuid]
      );

      const ydoc = new Y.Doc();
      if (result.rows.length > 0) {
        ydoc.transact(() => {
          for (const row of result.rows) {
            Y.applyUpdate(ydoc, new Uint8Array(row.update_data));
          }
        });
      }

      // Return a mock session with the loaded document
      return {
        provider: {
          doc: ydoc,
        },
        awareness: {
          setLocalStateField: jest.fn(),
        },
        sessionId: 'mock-session-id',
        agentInfo: {
          name: 'Test Agent',
          color: '#000000',
        },
        expiresIn: durationSeconds,
        reused: false,
      };
    }),
    setAgentPresence: jest.fn(),
    clearSession: jest.fn(),
    clearUserSessions: jest.fn(),
    getActiveSessions: jest.fn(() => new Map()),
  };
});

const { Pool } = require('pg');
const { PostgresPersistence } = require('../../../postgres-persistence');
const Y = require('yjs');

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
const delegation = require('../../auth/delegation');
const { generateAgentToken, verifyAgentToken } = require('../../auth/jwt');
const { requireAgentAuth, requireScope } = require('../../auth/middleware');
const listDocuments = require('../../tools/list-documents');
const getDocumentStructure = require('../../tools/get-document-structure');
const documents = require('../../../documents');
const agentPresence = require('../../agent-presence');

describe('Full Agent Workflow', () => {
  let testUserId;
  let testDocId;

  beforeAll(async () => {
    // Initialize all modules
    delegation.init(pool);
    documents.init(pool);
    listDocuments.init(persistenceProvider);
    getDocumentStructure.init(persistenceProvider);
    agentPresence.init(persistenceProvider);

    // Create test user
    const userResult = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-workflow-test', 'workflow-test@example.com', 'Workflow Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Create test document with content
    const docResult = await pool.query(
      `INSERT INTO documents (id, creator_id)
       VALUES (uuid_generate_v4(), $1)
       RETURNING id`,
      [testUserId]
    );
    testDocId = docResult.rows[0].id;
    await documents.setRole(testDocId, testUserId, 'owner');

    // Add Yjs content to the document
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Integration test document content.');
    paragraph.insert(0, [text]);
    xmlFragment.insert(0, [paragraph]);

    const update = Y.encodeStateAsUpdate(ydoc);
    await pool.query(
      'INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id) VALUES ($1, $2, $3, $4)',
      [testDocId, 1, Buffer.from(update), testUserId]
    );
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM agent_activity_log WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [testDocId]);
    await pool.query('DELETE FROM document_shares WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  describe('Complete Agent Authorization Flow', () => {
    test('user can authorize an agent and agent can access documents', async () => {
      // Step 1: User creates a delegation for the agent
      const agentDelegation = await delegation.createDelegation(
        testUserId,
        'claude-code:integration-test',
        'Claude Code (Integration Test)',
        {
          scopes: ['documents:read', 'documents:write'],
        }
      );

      expect(agentDelegation.id).toBeDefined();
      expect(agentDelegation.user_id).toBe(testUserId);
      expect(agentDelegation.agent_id).toBe('claude-code:integration-test');

      // Step 2: Generate a JWT token for the agent
      const agentToken = generateAgentToken(agentDelegation);
      expect(typeof agentToken).toBe('string');

      // Step 3: Verify the token works
      const decoded = verifyAgentToken(agentToken);
      expect(decoded.delegationId).toBe(agentDelegation.id);
      expect(decoded.userId).toBe(testUserId);
      expect(decoded.agentId).toBe('claude-code:integration-test');
      expect(decoded.isAgent).toBe(true);

      // Step 4: Simulate middleware authentication
      const mockReq = {
        headers: { authorization: `Bearer ${agentToken}` },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      const mockNext = jest.fn();

      requireAgentAuth(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.agentToken).toBeDefined();
      expect(mockReq.agentToken.userId).toBe(testUserId);

      // Step 5: Check scope middleware
      mockNext.mockClear();
      const scopeMiddleware = requireScope('documents:read');
      scopeMiddleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();

      // Step 6: Use list_documents tool
      const listResult = await listDocuments.handler({}, mockReq.agentToken);

      expect(listResult.documents).toBeDefined();
      expect(Array.isArray(listResult.documents)).toBe(true);
      expect(listResult.documents.map((d) => d.id)).toContain(testDocId);

      // Step 7: Use get_document_structure tool
      const structureResult = await getDocumentStructure.handler(
        { docGuid: testDocId },
        mockReq.agentToken
      );

      expect(structureResult.docGuid).toBe(testDocId);
      expect(structureResult.structure).toBeDefined();
      expect(structureResult.totalElements).toBe(1);
      expect(structureResult.structure).toContain('Integration test document content.');
    });
  });

  describe('Delegation Validation', () => {
    test('revoked delegation prevents access', async () => {
      // Create and then revoke a delegation
      const agentDelegation = await delegation.createDelegation(
        testUserId,
        'claude-code:revoked-test',
        'Claude Code (Revoked)',
        { scopes: ['documents:read'] }
      );

      await delegation.revokeDelegation(agentDelegation.id);

      // Verify delegation is invalid
      const checkResult = await delegation.checkDelegation(
        agentDelegation.id,
        'documents:read'
      );

      expect(checkResult.isValid).toBe(false);
      expect(checkResult.reason).toContain('revoked');
    });

    test('scope restriction prevents unauthorized operations', async () => {
      // Create delegation with only read scope
      const agentDelegation = await delegation.createDelegation(
        testUserId,
        'claude-code:read-only-test',
        'Claude Code (Read Only)',
        { scopes: ['documents:read'] } // No write scope
      );

      const agentToken = generateAgentToken(agentDelegation);
      const decoded = verifyAgentToken(agentToken);

      // Simulate middleware
      const mockReq = {
        headers: { authorization: `Bearer ${agentToken}` },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      const mockNext = jest.fn();

      requireAgentAuth(mockReq, mockRes, mockNext);

      // Try to access write scope - should fail
      mockNext.mockClear();
      mockRes.status.mockClear();
      mockRes.json.mockClear();

      const writeScope = requireScope('documents:write');
      writeScope(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Insufficient scope',
          code: 'INSUFFICIENT_SCOPE',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('Activity Logging', () => {
    test('agent actions are logged for audit', async () => {
      // Create delegation
      const agentDelegation = await delegation.createDelegation(
        testUserId,
        'claude-code:audit-test',
        'Claude Code (Audit)',
        { scopes: ['documents:read'] }
      );

      // Log some actions
      await delegation.logAgentAction(agentDelegation.id, 'document:list', {});
      await delegation.logAgentAction(agentDelegation.id, 'document:read', {
        docGuid: testDocId,
      });

      // Verify logs exist
      const logs = await pool.query(
        'SELECT * FROM agent_activity_log WHERE delegation_id = $1 ORDER BY created_at ASC',
        [agentDelegation.id]
      );

      expect(logs.rows).toHaveLength(2);
      expect(logs.rows[0].action).toBe('document:list');
      expect(logs.rows[1].action).toBe('document:read');
      expect(logs.rows[1].doc_guid).toBe(testDocId);

      // Verify last_used_at was updated
      const updatedDelegation = await delegation.getDelegation(agentDelegation.id);
      expect(updatedDelegation.last_used_at).not.toBeNull();
    });
  });

  describe('Token Expiration', () => {
    test('expired tokens are rejected by middleware', async () => {
      const jwt = require('jsonwebtoken');

      // Create an expired token manually
      const expiredToken = jwt.sign(
        {
          delegationId: 'test-delegation',
          userId: testUserId,
          agentId: 'claude-code:expired',
          agentName: 'Claude Code',
          scopes: ['documents:read'],
          isAgent: true,
        },
        process.env.MCP_JWT_SECRET,
        { expiresIn: '-1h', issuer: 'collab-app-mcp' }
      );

      const mockReq = {
        headers: { authorization: `Bearer ${expiredToken}` },
        query: {},
      };
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      const mockNext = jest.fn();

      requireAgentAuth(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Agent token expired',
        code: 'TOKEN_EXPIRED',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('Cross-User Document Access', () => {
    let otherUserId;
    let privateDocId;

    beforeAll(async () => {
      // Create another user with a private document
      const otherUserResult = await pool.query(
        `INSERT INTO users (id, google_id, email, name)
         VALUES (uuid_generate_v4(), 'google-other-user', 'other-user@example.com', 'Other User')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
      );
      otherUserId = otherUserResult.rows[0].id;

      const privateDocResult = await pool.query(
        `INSERT INTO documents (id, creator_id)
         VALUES (uuid_generate_v4(), $1)
         RETURNING id`,
        [otherUserId]
      );
      privateDocId = privateDocResult.rows[0].id;
      await documents.setRole(privateDocId, otherUserId, 'owner');
    });

    afterAll(async () => {
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [privateDocId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [privateDocId]);
      await pool.query('DELETE FROM users WHERE id = $1', [otherUserId]);
    });

    test('agent cannot access documents that user does not have access to', async () => {
      // Create delegation for test user
      const agentDelegation = await delegation.createDelegation(
        testUserId,
        'claude-code:cross-user-test',
        'Claude Code',
        { scopes: ['documents:read'] }
      );

      const agentToken = generateAgentToken(agentDelegation);
      const decoded = verifyAgentToken(agentToken);

      // Try to access other user's private document
      await expect(
        getDocumentStructure.handler({ docGuid: privateDocId }, decoded)
      ).rejects.toThrow(/not found|access/i);
    });

    test('agent cannot see documents in list that user does not have access to', async () => {
      const agentDelegation = await delegation.createDelegation(
        testUserId,
        'claude-code:list-cross-test',
        'Claude Code',
        { scopes: ['documents:read'] }
      );

      const agentToken = generateAgentToken(agentDelegation);
      const decoded = verifyAgentToken(agentToken);

      const listResult = await listDocuments.handler({}, decoded);

      // Should not include the private document
      expect(listResult.documents.map((d) => d.id)).not.toContain(privateDocId);
    });
  });
});
