/**
 * create_access_token MCP tool tests
 *
 * Drives the tool through toolRegistry.executeTool so TOOL_SCOPES gating and
 * validateToolArgs run, against a real test database. Covers both principal
 * shapes (OAuth-JWT delegation and PAT), scope capping, TTL bounds, the
 * no-chaining rule, the per-minter cap, and plaintext hygiene.
 */
const { createPool, createTestUser, cleanupTestUser } = require('../../../__tests__/helpers/db');
const apiTokens = require('../../auth/api-tokens');
const delegation = require('../../auth/delegation');
const toolRegistry = require('../../tools');

const pool = createPool();

describe('create_access_token tool', () => {
  let testUserId;
  let testDelegation;

  const mint = (args, agentToken) =>
    toolRegistry.executeTool('create_access_token', args, agentToken);

  const jwtPrincipal = (overrides = {}) => ({
    delegationId: testDelegation.id,
    userId: testUserId,
    agentId: 'test-agent',
    agentName: 'Test Agent',
    scopes: ['documents:read', 'documents:write'],
    isAgent: true,
    baseUrl: 'https://test.example.com',
    ...overrides,
  });

  const patPrincipal = (apiTokenId, overrides = {}) => ({
    userId: testUserId,
    agentId: `api-token:${apiTokenId}`,
    agentName: 'Test PAT',
    scopes: ['documents:read', 'documents:write'],
    isAgent: true,
    apiTokenId,
    ...overrides,
  });

  beforeAll(async () => {
    apiTokens.init(pool);
    delegation.init(pool);
    testUserId = await createTestUser(pool, 'create-access-token-test@example.com');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [testUserId]);
    await cleanupTestUser(pool, testUserId);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [testUserId]);
    testDelegation = await delegation.createDelegation(testUserId, 'test-agent', 'Test Agent');
  });

  describe('claim delivery (default)', () => {
    test('result carries a claim recipe and NO token', async () => {
      const result = await mint({}, jwtPrincipal());

      expect(result.token).toBeUndefined();
      expect(result.scopes).toEqual(['documents:read']);
      expect(result.ttlSeconds).toBe(3600);
      expect(result.claimUrl).toBe('https://test.example.com/api/tokens/claim');
      expect(result.claimExpiresInSeconds).toBe(300);
      expect(result.claimCommand).toMatch(/Bearer one_time_use_[A-Za-z0-9_-]+/);
      expect(result.claimCommand).toContain('-o ~/.squire/token');
      expect(result.message).toContain('No token is included in this response');
      expect(result.curlExample).toContain('/api/docs/<docId>/export?format=markdown');
      expect(result.curlExample).toContain('https://test.example.com');
      expect(result.curlExample).toContain('$(cat ~/.squire/token)');
    });

    test('no token row is created until the claim is redeemed', async () => {
      await mint({}, jwtPrincipal());
      const active = await apiTokens.listUserTokens(testUserId);
      expect(active).toHaveLength(0);
    });
  });

  describe('inline delivery (explicit opt-in)', () => {
    test('mints a read-only 1h token with sk_sqd_ prefix and warning', async () => {
      const before = Date.now();
      const result = await mint({ inline: true }, jwtPrincipal());

      expect(result.token.startsWith('sk_sqd_')).toBe(true);
      expect(result.warning).toMatch(/never print, echo/i);
      expect(result.scopes).toEqual(['documents:read']);
      expect(result.ttlSeconds).toBe(3600);
      const expiresAt = new Date(result.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000);
      expect(result.curlExample).toContain('/api/docs/<docId>/export?format=markdown');
      expect(result.curlExample).toContain('https://test.example.com');
    });

    test('minted token verifies and carries delegation provenance', async () => {
      const result = await mint({ inline: true }, jwtPrincipal());
      const record = await apiTokens.verifyToken(result.token);
      expect(record).not.toBeNull();
      expect(record.user_id).toBe(testUserId);

      const row = await apiTokens.getTokenById(record.id);
      expect(row.minted_by_delegation_id).toBe(testDelegation.id);
      expect(row.minted_by_api_token_id).toBeNull();
    });

    test('PAT principal records parent token provenance', async () => {
      const { record: parent } = await apiTokens.createToken(testUserId, 'Parent PAT');
      const result = await mint({ inline: true }, patPrincipal(parent.id));

      const record = await apiTokens.verifyToken(result.token);
      const row = await apiTokens.getTokenById(record.id);
      expect(row.minted_by_api_token_id).toBe(parent.id);
      expect(row.minted_by_delegation_id).toBeNull();
    });

    // Feature 037: the default name describes the AGENT, not the operation.
    // Since 037 this string is a user-facing presence label and a
    // version-history author, so it must answer "who is here".
    test('auto-generates an agent-descriptive name visible in Settings', async () => {
      const result = await mint({ inline: true }, jwtPrincipal());
      const record = await apiTokens.verifyToken(result.token);
      expect(record.name).toBe('Test Agent');
      expect(record.name).not.toMatch(/Minted by|via MCP/);
    });
  });

  describe('scope capping', () => {
    test('honors an explicit scopes request within the caller grant', async () => {
      const result = await mint({ scopes: ['documents:read', 'documents:write'] }, jwtPrincipal());
      expect(result.scopes).toEqual(['documents:read', 'documents:write']);
    });

    test('read-only caller cannot mint a write token', async () => {
      await expect(
        mint({ scopes: ['documents:write'] }, jwtPrincipal({ scopes: ['documents:read'] }))
      ).rejects.toThrow(/Insufficient scope: cannot mint a token with scope 'documents:write'/);
    });

    test('caller without documents:read is blocked by TOOL_SCOPES', async () => {
      await expect(mint({}, jwtPrincipal({ scopes: [] }))).rejects.toThrow(
        /Insufficient scope: 'documents:read' is required/
      );
    });

    test('rejects unknown scope values', async () => {
      await expect(mint({ scopes: ['documents:admin'] }, jwtPrincipal())).rejects.toThrow(
        /unknown scope 'documents:admin'/
      );
    });

    test('rejects empty or non-array scopes', async () => {
      await expect(mint({ scopes: [] }, jwtPrincipal())).rejects.toThrow(/non-empty array/);
      await expect(mint({ scopes: 'documents:read' }, jwtPrincipal())).rejects.toThrow(/non-empty array/);
    });
  });

  describe('ttlSeconds bounds', () => {
    test('accepts the bounds and rejects outside them', async () => {
      const min = await mint({ ttlSeconds: 60 }, jwtPrincipal());
      expect(min.ttlSeconds).toBe(60);
      const max = await mint({ ttlSeconds: 86400 }, jwtPrincipal());
      expect(max.ttlSeconds).toBe(86400);

      await expect(mint({ ttlSeconds: 59 }, jwtPrincipal())).rejects.toThrow(/between 60 and 86400/);
      await expect(mint({ ttlSeconds: 86401 }, jwtPrincipal())).rejects.toThrow(/between 60 and 86400/);
      await expect(mint({ ttlSeconds: 3600.5 }, jwtPrincipal())).rejects.toThrow(/between 60 and 86400/);
      await expect(mint({ ttlSeconds: 'soon' }, jwtPrincipal())).rejects.toThrow(/between 60 and 86400/);
    });
  });

  describe('no chaining', () => {
    test('a minted token cannot mint further tokens', async () => {
      const first = await mint({ inline: true }, jwtPrincipal());
      const minted = await apiTokens.verifyToken(first.token);

      await expect(mint({}, patPrincipal(minted.id))).rejects.toThrow(
        /cannot mint further tokens/
      );
    });
  });

  describe('delegation liveness', () => {
    test('a revoked delegation cannot mint even with a live JWT', async () => {
      await delegation.revokeDelegation(testDelegation.id);
      await expect(mint({}, jwtPrincipal())).rejects.toThrow(/Cannot mint token: .*revoked/);
    });
  });

  describe('per-minter cap', () => {
    test('minting one past the cap revokes the oldest', async () => {
      const cap = apiTokens.MAX_MINTED_PER_MINTER;
      const tokens = [];
      for (let i = 0; i < cap + 1; i++) {
        tokens.push(await mint({ inline: true }, jwtPrincipal()));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(tokens[cap].message).toContain('older minted token(s) were revoked');
      expect(await apiTokens.verifyToken(tokens[0].token)).toBeNull();
      expect(await apiTokens.verifyToken(tokens[cap].token)).not.toBeNull();

      const active = await apiTokens.listUserTokens(testUserId);
      expect(active).toHaveLength(cap);
    });
  });

  describe('global cap passthrough', () => {
    test('the per-user token cap still applies', async () => {
      const max = apiTokens.MAX_TOKENS_PER_USER;
      for (let i = 0; i < max; i++) {
        await apiTokens.createToken(testUserId, `Filler ${i}`);
      }
      await expect(mint({ inline: true }, jwtPrincipal())).rejects.toThrow(/Maximum of \d+ active tokens/);
    });
  });

  describe('plaintext hygiene', () => {
    test('DB stores only the hash; nothing is console-logged during mint', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await mint({ inline: true }, jwtPrincipal());

        const dbResult = await pool.query(
          'SELECT token_hash FROM mcp_api_tokens WHERE user_id = $1',
          [testUserId]
        );
        for (const row of dbResult.rows) {
          expect(row.token_hash).not.toBe(result.token);
          expect(row.token_hash).not.toContain(result.token);
        }

        const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
        expect(logged).not.toContain(result.token);
        // The curl example must not embed the raw secret either
        expect(result.curlExample).not.toContain(result.token);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  // =========================================================================
  // Token naming (feature 037, US5) — assertions N2-N5, N7.
  //
  // The name is no longer bookkeeping: since 037 it is the live presence label
  // a watching human sees while the agent works, and the version-history
  // author. So it must describe the AGENT, and a caller who knows what it is
  // called must be able to say so.
  // =========================================================================
  describe('token naming (037)', () => {
    async function storedName(result) {
      const record = await apiTokens.verifyToken(result.token);
      return record.name;
    }

    test('N2: no name ⇒ the derived agent name, never an operation string', async () => {
      const result = await mint({ inline: true }, jwtPrincipal());
      expect(await storedName(result)).toBe('Test Agent');
    });

    test('N3: an explicit name is stored verbatim (inline path)', async () => {
      const result = await mint({ inline: true, name: 'Repo CI' }, jwtPrincipal());
      expect(await storedName(result)).toBe('Repo CI');
    });

    test('N3: an explicit name is stored verbatim (claim path)', async () => {
      // The claim path defers the mint to redemption, stashing the parameters
      // in Redis — so assert at that module boundary rather than on a token row
      // that does not exist yet.
      const pendingMints = require('../../auth/pending-mints');
      const spy = jest.spyOn(pendingMints, 'createPendingMint');
      try {
        await mint({ name: 'Repo CI' }, jwtPrincipal());
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toMatchObject({ name: 'Repo CI', userId: testUserId });
      } finally { spy.mockRestore(); }
    });

    test('N2: the claim path also defaults to the derived agent name', async () => {
      const pendingMints = require('../../auth/pending-mints');
      const spy = jest.spyOn(pendingMints, 'createPendingMint');
      try {
        await mint({}, jwtPrincipal());
        expect(spy.mock.calls[0][0].name).toBe('Test Agent');
      } finally { spy.mockRestore(); }
    });

    test('N3: a name is trimmed before storage', async () => {
      const result = await mint({ inline: true, name: '  Repo CI  ' }, jwtPrincipal());
      expect(await storedName(result)).toBe('Repo CI');
    });

    test.each([
      ['empty', ''],
      ['whitespace only', '   '],
      ['not a string', 42],
      ['over 255 chars', 'x'.repeat(256)],
    ])('N4: %s ⇒ invalid-parameter error, and nothing is minted', async (_label, bad) => {
      await expect(mint({ inline: true, name: bad }, jwtPrincipal()))
        .rejects.toThrow(/Invalid parameters for tool 'create_access_token'.*'name'/s);
      const rows = await pool.query(
        'SELECT COUNT(*)::int AS n FROM mcp_api_tokens WHERE user_id = $1', [testUserId]
      );
      expect(rows.rows[0].n).toBe(0);
    });

    test('N5: a principal with no agentName ⇒ "AI Agent", never api-token:<id>', async () => {
      const result = await mint(
        { inline: true },
        jwtPrincipal({ agentName: undefined, agentId: 'api-token:abc-123' })
      );
      const stored = await storedName(result);
      expect(stored).toBe('AI Agent');
      expect(stored).not.toContain('api-token:');
    });

    // The name is text a remote agent gets to draw into a watching human's
    // window, and trim() strips none of Unicode's invisible characters.
    test('N6: a name of nothing but zero-width characters falls back to the derived name', async () => {
      const result = await mint({ inline: true, name: '\u200B\u200B\u2060' }, jwtPrincipal());
      expect(await storedName(result)).toBe('Test Agent');
    });

    test('N6: zero-width and bidi characters are stripped from an otherwise valid name', async () => {
      const result = await mint(
        { inline: true, name: 'Repo\u200B CI\u202E' }, jwtPrincipal()
      );
      const stored = await storedName(result);
      expect(stored).toBe('Repo CI');
      expect(stored).not.toMatch(/[\u200B\u202E]/);
    });

    test('N6: an invisible-laden principal name is cleaned before it becomes the default', async () => {
      const result = await mint(
        { inline: true }, jwtPrincipal({ agentName: 'Cla\u200Bude Code' })
      );
      expect(await storedName(result)).toBe('Claude Code');
    });

    test('N7: the tool description instructs naming the token after the agent', () => {
      const tool = require('../../tools/create-access-token');
      expect(tool.description).toMatch(/name the token after YOURSELF/i);
      expect(tool.description).toMatch(/presence label/i);
      expect(tool.description).toMatch(/version history/i);
      // The parameter carries the same contract, since that is what an agent
      // reads when it decides what to pass.
      expect(tool.inputSchema.properties.name.description).toMatch(/YOURSELF/);
    });
  });
});
