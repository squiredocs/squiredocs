/**
 * Tests for OAuth 2.0 authorization flow
 */
const crypto = require('crypto');

// Mock dependencies
jest.mock('../../auth/registered-agents');
jest.mock('../../auth/delegation');
jest.mock('../../auth/jwt');
jest.mock('../../auth/pkce');

const oauthFlow = require('../../auth/oauth-flow');
const registeredAgents = require('../../auth/registered-agents');
const delegation = require('../../auth/delegation');
const jwt = require('../../auth/jwt');
const pkce = require('../../auth/pkce');

describe('OAuth Flow', () => {
  let mockPool;
  let mockReq;
  let mockRes;

  beforeEach(() => {
    // Mock database pool
    mockPool = {
      query: jest.fn(),
    };

    // Initialize OAuth flow
    oauthFlow.init(mockPool);

    // Mock request and response
    mockReq = {
      query: {},
      body: {},
      user: null,
      session: {},
      headers: {},
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      redirect: jest.fn().mockReturnThis(),
    };

    // Clear all mocks
    jest.clearAllMocks();

    // Default mock implementations
    registeredAgents.getRegisteredAgent.mockResolvedValue({
      id: 'claude-code',
      name: 'Claude Code',
      allowed_redirect_uris: ['http://localhost:*/callback'],
      allowed_scopes: ['documents:read', 'documents:write'],
      default_scopes: ['documents:read'],
    });

    registeredAgents.validateScopes.mockReturnValue({
      valid: true,
      scopes: ['documents:read', 'documents:write'],
    });

    registeredAgents.validateRedirectUri.mockReturnValue({ valid: true });

    pkce.validateCodeChallenge.mockReturnValue({ valid: true });
    pkce.generateAuthCode.mockReturnValue('mock-auth-code-123');
    pkce.hashAuthCode.mockReturnValue('mock-code-hash');
    pkce.validateCodeVerifier.mockReturnValue({ valid: true });

    jwt.generateAgentToken.mockReturnValue('mock-jwt-token');

    delegation.createDelegation.mockResolvedValue({
      id: 'mock-delegation-id',
      user_id: 'user-123',
      agent_id: 'claude-code',
      agent_name: 'Claude Code',
      scopes: ['documents:read', 'documents:write'],
    });

    delegation.getActiveDelegation.mockResolvedValue(null);
  });

  describe('handleAuthorize', () => {
    test('validates required parameters', async () => {
      mockReq.query = {}; // Missing all required params

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' })
      );
    });

    test('requires agent_client_id', async () => {
      mockReq.query = {
        redirect_uri: 'http://localhost:3000/callback',
        code_challenge: 'challenge',
        state: 'state',
      };

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          details: expect.arrayContaining([
            expect.stringContaining('client_id'),
          ]),
        })
      );
    });

    test('requires redirect_uri', async () => {
      mockReq.query = {
        agent_client_id: 'claude-code',
        code_challenge: 'challenge',
        state: 'state',
      };

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    test('requires code_challenge for PKCE', async () => {
      mockReq.query = {
        agent_client_id: 'claude-code',
        redirect_uri: 'http://localhost:3000/callback',
        state: 'state',
      };

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.arrayContaining([
            expect.stringContaining('code_challenge'),
          ]),
        })
      );
    });

    test('validates agent_client_id exists', async () => {
      registeredAgents.getRegisteredAgent.mockResolvedValue(null);

      mockReq.query = {
        agent_client_id: 'unknown-agent',
        redirect_uri: 'http://localhost:3000/callback',
        code_challenge: 'challenge',
        state: 'state',
      };

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_client' })
      );
    });

    test('validates redirect_uri', async () => {
      registeredAgents.validateRedirectUri.mockReturnValue({
        valid: false,
        error: 'Invalid redirect URI',
      });

      mockReq.query = {
        agent_client_id: 'claude-code',
        redirect_uri: 'https://evil.com/steal',
        code_challenge: 'challenge',
        state: 'state',
      };

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    test('validates code_challenge format', async () => {
      pkce.validateCodeChallenge.mockReturnValue({
        valid: false,
        error: 'Invalid challenge',
      });

      mockReq.query = {
        agent_client_id: 'claude-code',
        redirect_uri: 'http://localhost:3000/callback',
        code_challenge: 'bad-challenge',
        state: 'state',
      };

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    test('redirects unauthenticated user to consent page', async () => {
      mockReq.user = null;
      mockReq.query = {
        agent_client_id: 'claude-code',
        redirect_uri: 'http://localhost:3000/callback',
        code_challenge: 'challenge',
        state: 'state',
      };

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('/authorize?')
      );
    });

    test('redirects authenticated user to consent page', async () => {
      mockReq.user = { userId: 'user-123' };
      mockReq.query = {
        agent_client_id: 'claude-code',
        redirect_uri: 'http://localhost:3000/callback',
        code_challenge: 'challenge',
        state: 'state',
        scope: 'documents:read',
      };

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('/authorize?')
      );
    });

    test('checks for existing delegation', async () => {
      mockReq.user = { userId: 'user-123' };
      mockReq.query = {
        agent_client_id: 'claude-code',
        redirect_uri: 'http://localhost:3000/callback',
        code_challenge: 'challenge',
        state: 'state',
      };

      delegation.getActiveDelegation.mockResolvedValue({ id: 'existing-123' });

      await oauthFlow.handleAuthorize(mockReq, mockRes);

      expect(delegation.getActiveDelegation).toHaveBeenCalledWith(
        'user-123',
        'claude-code'
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('existing_delegation=true')
      );
    });
  });

  describe('handleApprove', () => {
    beforeEach(() => {
      mockReq.user = { userId: 'user-123' };
      mockReq.body = {
        agent_client_id: 'claude-code',
        scopes: ['documents:read', 'documents:write'],
        redirect_uri: 'http://localhost:3000/callback',
        state: 'state-123',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        approved: true,
      };
    });

    test('requires authentication', async () => {
      mockReq.user = null;

      await oauthFlow.handleApprove(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'unauthorized' })
      );
    });

    test('handles user denial', async () => {
      mockReq.body.approved = false;
      mockReq.headers.accept = 'application/json';

      await oauthFlow.handleApprove(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          redirectUrl: expect.stringContaining('error=access_denied'),
        })
      );
    });

    test('generates authorization code on approval', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });

      await oauthFlow.handleApprove(mockReq, mockRes);

      expect(pkce.generateAuthCode).toHaveBeenCalled();
      expect(pkce.hashAuthCode).toHaveBeenCalledWith('mock-auth-code-123');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO mcp_auth_codes'),
        expect.any(Array)
      );
    });

    test('returns redirect URL with authorization code', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });
      mockReq.headers.accept = 'application/json';

      await oauthFlow.handleApprove(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          redirectUrl: expect.stringContaining('code=mock-auth-code-123'),
        })
      );
    });

    test('validates agent exists', async () => {
      registeredAgents.getRegisteredAgent.mockResolvedValue(null);

      await oauthFlow.handleApprove(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_client' })
      );
    });

    test('validates scopes', async () => {
      registeredAgents.validateScopes.mockReturnValue({
        valid: false,
        error: 'Invalid scopes',
      });

      await oauthFlow.handleApprove(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_scope' })
      );
    });
  });

  describe('handleToken - authorization_code grant', () => {
    beforeEach(() => {
      mockReq.body = {
        grant_type: 'authorization_code',
        code: 'auth-code-123',
        code_verifier: 'verifier-123',
        redirect_uri: 'http://localhost:3000/callback',
      };

      mockPool.query.mockResolvedValue({
        rows: [
          {
            code_hash: 'hash',
            user_id: 'user-123',
            agent_client_id: 'claude-code',
            agent_instance_id: 'instance-123',
            scopes: ['documents:read', 'documents:write'],
            code_challenge: 'challenge',
            code_challenge_method: 'S256',
            redirect_uri: 'http://localhost:3000/callback',
            expires_at: new Date(Date.now() + 300000),
          },
        ],
      });
    });

    test('requires code parameter', async () => {
      mockReq.body.code = null;

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('code'),
        })
      );
    });

    test('requires code_verifier for PKCE', async () => {
      mockReq.body.code_verifier = null;

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error_description: expect.stringContaining('code_verifier'),
        })
      );
    });

    test('validates authorization code exists', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // No code found

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_grant',
        })
      );
    });

    test('validates redirect_uri matches', async () => {
      mockReq.body.redirect_uri = 'http://different-uri.com/callback';

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error_description: expect.stringContaining('redirect_uri'),
        })
      );
    });

    test('validates PKCE code_verifier', async () => {
      pkce.validateCodeVerifier.mockReturnValue({
        valid: false,
        error: 'Invalid verifier',
      });

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_grant' })
      );
    });

    test('marks authorization code as used', async () => {
      const authCodeRow = {
        code_hash: 'hash',
        user_id: 'user-123',
        agent_client_id: 'claude-code',
        agent_instance_id: 'instance-123',
        scopes: ['documents:read', 'documents:write'],
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        redirect_uri: 'http://localhost:3000/callback',
        expires_at: new Date(Date.now() + 300000),
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [authCodeRow] }) // Get code
        .mockResolvedValueOnce({ rowCount: 1 }) // Mark as used
        .mockResolvedValueOnce({ rowCount: 1 }); // Update delegation

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE mcp_auth_codes SET used_at'),
        expect.any(Array)
      );
    });

    test('creates delegation', async () => {
      const authCodeRow = {
        code_hash: 'hash',
        user_id: 'user-123',
        agent_client_id: 'claude-code',
        agent_instance_id: 'instance-123',
        scopes: ['documents:read', 'documents:write'],
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        redirect_uri: 'http://localhost:3000/callback',
        expires_at: new Date(Date.now() + 300000),
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [authCodeRow] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 });

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(delegation.createDelegation).toHaveBeenCalledWith(
        'user-123',
        expect.stringContaining('claude-code'),
        'Claude Code',
        expect.objectContaining({
          scopes: ['documents:read', 'documents:write'],
        })
      );
    });

    test('returns access token and refresh token', async () => {
      const authCodeRow = {
        code_hash: 'hash',
        user_id: 'user-123',
        agent_client_id: 'claude-code',
        agent_instance_id: 'instance-123',
        scopes: ['documents:read', 'documents:write'],
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        redirect_uri: 'http://localhost:3000/callback',
        expires_at: new Date(Date.now() + 300000),
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [authCodeRow] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 });

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          access_token: 'mock-jwt-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: expect.any(String),
          scope: 'documents:read documents:write',
        })
      );
    });
  });

  describe('handleToken - refresh_token grant', () => {
    beforeEach(() => {
      mockReq.body = {
        grant_type: 'refresh_token',
        refresh_token: 'refresh-token-123',
      };

      const refreshTokenHash = crypto
        .createHash('sha256')
        .update('refresh-token-123')
        .digest('hex');

      mockPool.query.mockResolvedValue({
        rows: [
          {
            id: 'delegation-123',
            user_id: 'user-123',
            agent_id: 'claude-code',
            agent_name: 'Claude Code',
            scopes: ['documents:read', 'documents:write'],
            refresh_token_hash: refreshTokenHash,
            refresh_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            revoked_at: null,
          },
        ],
      });
    });

    test('requires refresh_token parameter', async () => {
      mockReq.body.refresh_token = null;

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error_description: expect.stringContaining('refresh_token'),
        })
      );
    });

    test('validates refresh token exists', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_grant',
        })
      );
    });

    test('rotates refresh token', async () => {
      const delegationRow = {
        id: 'delegation-123',
        user_id: 'user-123',
        agent_id: 'claude-code',
        agent_name: 'Claude Code',
        scopes: ['documents:read', 'documents:write'],
        refresh_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [delegationRow] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agent_delegations'),
        expect.arrayContaining([
          expect.any(String), // New refresh token hash
          expect.any(Date), // New expiration
          'delegation-123',
        ])
      );
    });

    test('returns new access token and refresh token', async () => {
      const delegationRow = {
        id: 'delegation-123',
        user_id: 'user-123',
        agent_id: 'claude-code',
        agent_name: 'Claude Code',
        scopes: ['documents:read', 'documents:write'],
        refresh_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [delegationRow] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await oauthFlow.handleToken(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          access_token: 'mock-jwt-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: expect.any(String),
          scope: 'documents:read documents:write',
        })
      );
    });

    test('new refresh token is different from old', async () => {
      const delegationRow = {
        id: 'delegation-123',
        user_id: 'user-123',
        agent_id: 'claude-code',
        agent_name: 'Claude Code',
        scopes: ['documents:read', 'documents:write'],
        refresh_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        revoked_at: null,
      };

      mockPool.query
        .mockResolvedValueOnce({ rows: [delegationRow] })
        .mockResolvedValueOnce({ rowCount: 1 });

      await oauthFlow.handleToken(mockReq, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.refresh_token).not.toBe('refresh-token-123');
    });
  });

  describe('handleRevoke', () => {
    test('revokes refresh token', async () => {
      mockReq.body = { token: 'refresh-token-123' };
      mockPool.query.mockResolvedValue({ rowCount: 1 });

      await oauthFlow.handleRevoke(mockReq, mockRes);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agent_delegations'),
        expect.any(Array)
      );
      expect(mockRes.json).toHaveBeenCalledWith({ success: true });
    });

    test('returns success even if token not found', async () => {
      mockReq.body = { token: 'unknown-token' };
      mockPool.query.mockResolvedValue({ rowCount: 0 });

      await oauthFlow.handleRevoke(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({ success: true });
    });

    test('requires token parameter', async () => {
      mockReq.body = {};

      await oauthFlow.handleRevoke(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });
});
