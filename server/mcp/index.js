/**
 * MCP Server Router
 *
 * Implements the Model Context Protocol for AI agent access.
 * Uses Streamable HTTP transport with JSON-RPC style messages.
 */
const express = require('express');
const { buildChallenge, requireAgentAuth, requireScope, optionalAgentAuth } = require('./auth/middleware');
const { requireAuth } = require('../auth/middleware');
const { generateAgentToken, extractAgentToken } = require('./auth/jwt');
const delegation = require('./auth/delegation');
const registeredAgents = require('./auth/registered-agents');
const oauthFlow = require('./auth/oauth-flow');
const oauthRouter = require('./auth/oauth-router');
const apiTokens = require('./auth/api-tokens');
const loginService = require('./auth/login-service');
const toolRegistry = require('./tools');
const { buildBaseUrl } = require('../url');
const { notifyException } = require('../exception-notifier');

const router = express.Router();

// Persistence provider - set by init function
let persistenceProvider = null;

// MCP Protocol version
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'collab-editor-mcp';
const SERVER_VERSION = '1.0.0';

/**
 * Initialize the MCP server with persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
  const pool = persistence.getPool();
  delegation.init(pool);
  registeredAgents.init(pool);
  oauthFlow.init(pool);
  apiTokens.init(pool);
  loginService.init(pool);
  toolRegistry.init(persistence);
}

/**
 * Send the byte-identical "missing credential" 401 challenge.
 *
 * Reuses buildChallenge and the exact JSON body that requireAgentAuth emits, so
 * every non-login anonymous request stays indistinguishable from pre-feature
 * behavior (anonymous-surface contract; SC-003).
 */
function sendMissingChallenge(req, res) {
  res.set('WWW-Authenticate', buildChallenge(req, { branch: 'missing' }));
  return res.status(401).json({
    error: 'No agent token provided',
    code: 'MISSING_TOKEN',
  });
}

/**
 * Auth wrapper for the anonymous surface (feature 008, contract
 * anonymous-surface.md). When a credential is PRESENT, defers entirely to
 * requireAgentAuth — so the authenticated path and the invalid/expired 401
 * branches are byte-identical. When ABSENT, lets the request proceed as
 * anonymous (req.agentToken stays unset); the JSON-RPC dispatch then allows only
 * initialize/tools-list/ping and tools/call for the two login tools, and issues
 * the byte-identical missing-credential 401 for everything else.
 */
function anonymousAwareAuth(req, res, next) {
  const token = extractAgentToken({
    authHeader: req.headers.authorization,
    queryToken: req.query?.token,
  });
  if (token) {
    return requireAgentAuth(req, res, next);
  }
  return next();
}

/** Tool list filtered for the caller: anonymous sees only the two login tools. */
function toolListFor(isAnonymous) {
  const all = toolRegistry.getToolList();
  if (!isAnonymous) return all;
  return all.filter((t) => toolRegistry.ANON_TOOL_NAMES.includes(t.name));
}

/**
 * MCP JSON-RPC response helper
 */
function jsonRpcResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

/**
 * Build the MCP tool-result `content` array from a tool's return value.
 * By default the result is JSON-stringified into a single text block. A tool
 * that needs to return richer content (e.g. an image block the agent can see)
 * returns `{ __mcpContent: [ ...blocks ] }` and those blocks are passed through
 * verbatim.
 */
function toToolResultContent(result) {
  if (result && Array.isArray(result.__mcpContent)) {
    return result.__mcpContent;
  }
  return [{ type: 'text', text: JSON.stringify(result, null, 2) }];
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

// Error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * GET /mcp - Server information (for discovery)
 */
router.get('/', (req, res) => {
  console.log('[MCP Discovery] Server info requested from:', req.get('origin') || req.get('referer') || 'unknown');
  const baseUrl = buildBaseUrl(req);
  res.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    authentication: {
      type: 'oauth2',
      authorizationUrl: `${baseUrl}/mcp/auth/authorize`,
      tokenUrl: `${baseUrl}/mcp/auth/token`,
      metadataUrl: `${baseUrl}/.well-known/oauth-authorization-server`,
      resource_metadata: `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    },
  });
});

/**
 * POST /mcp - Main MCP message endpoint
 * Handles JSON-RPC style messages
 * Requires authentication for all operations
 */
router.post('/', anonymousAwareAuth, async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  // A request with no credential proceeds anonymously (req.agentToken unset).
  const isAnonymous = !req.agentToken;

  // Log all MCP requests for debugging
  console.log(`[MCP] ${method} - authenticated: ${!!req.agentToken}`);

  // Validate JSON-RPC format. Anonymous callers get the byte-identical
  // missing-credential 401 here too: pre-feature-008, EVERY unauthenticated
  // request 401'd regardless of body shape, and the anonymous-surface contract
  // (SC-003) promises non-login clients observe no difference (008 review, LOW).
  if (jsonrpc !== '2.0') {
    if (isAnonymous) {
      return sendMissingChallenge(req, res);
    }
    return res.json(jsonRpcError(id, INVALID_REQUEST, 'Invalid JSON-RPC version'));
  }

  try {
    let result;

    switch (method) {
      case 'initialize':
        result = handleInitialize(params, isAnonymous);
        break;

      case 'tools/list':
        result = handleToolsList(isAnonymous);
        break;

      case 'tools/call': {
        const toolName = params && params.name;
        // Anonymous callers may only invoke the two login tools; everything else
        // gets the byte-identical missing-credential 401 (FR-001/FR-002).
        if (isAnonymous && !toolRegistry.ANON_TOOL_NAMES.includes(toolName)) {
          return sendMissingChallenge(req, res);
        }
        // Add baseUrl + clientIp to the tool context (authenticated login calls
        // need clientIp too, D2). Anonymous calls get a synthetic context.
        const context = isAnonymous
          ? { isAnonymous: true, baseUrl: buildBaseUrl(req), clientIp: req.ip }
          : Object.assign(req.agentToken, { baseUrl: buildBaseUrl(req), clientIp: req.ip });
        result = await handleToolCall(params, context);
        break;
      }

      case 'ping':
        result = {};
        break;

      default:
        // Anonymous unknown method → byte-identical missing 401 (contract);
        // authenticated unknown method keeps the JSON-RPC method-not-found error.
        if (isAnonymous) {
          return sendMissingChallenge(req, res);
        }
        return res.json(jsonRpcError(id, METHOD_NOT_FOUND, `Unknown method: ${method}`));
    }

    res.json(jsonRpcResponse(id, result));
  } catch (error) {
    console.error('MCP error:', error);
    notifyException(error, { req, source: 'mcp' });
    // In production, only return error message. In dev, include stack for debugging.
    const errorData = process.env.NODE_ENV === 'production'
      ? { name: error.name }
      : { stack: error.stack, name: error.name };
    res.json(jsonRpcError(id, INTERNAL_ERROR, error.message, errorData));
  }
});

// Sent to MCP clients at initialize. Clients such as Claude Code truncate
// server instructions at 2KB and use them to decide when to engage this
// server's tools, so keep this short with the critical details first.
const SERVER_INSTRUCTIONS =
  'Collaborative rich-text document server (docs, version history, real-time '
  + 'multi-user editing). Documents are edited with the modify tool and '
  + 'compared with compare_document_versions — both take TypeScript scripts '
  + 'and have a large scripting API (built-in helpers, XPath targeting, Yjs '
  + 'API, examples, common pitfalls) that does not fit in their tool '
  + 'descriptions. ALWAYS call get_tool_documentation({ tool: "modify" }) (or '
  + '{ tool: "compare_document_versions" }) before writing your first script. '
  + 'Read documents with read_document (optionally XPath-filtered); build '
  + 'documents incrementally with multiple small modify calls. CHANNEL RULE: '
  + 'markdown that already exists as bytes outside the model (a file on '
  + 'disk, another tool\'s output) should move over the REST byte channel — '
  + 'import AND export over HTTP via curl + an sk_sqd_ API token, '
  + 'byte-faithful, zero model involvement — never retyped through tool '
  + 'parameters like create_document({ markdown }). Model context should '
  + 'only carry content you are creating or transforming. Mint a token '
  + 'yourself with create_access_token, then see '
  + 'get_tool_documentation({ tool: "rest_api" }).';

// Sent to anonymous (credential-less) MCP clients at initialize. Kept well under
// the 2KB budget. States that the session is unauthenticated, names the two
// available tools and both escape hatches, and pins the credential-handling rule.
const ANON_SERVER_INSTRUCTIONS =
  'This MCP session is UNAUTHENTICATED — connected but with no credential, so '
  + 'only two tools are available: login and login_status. To gain the full '
  + 'document toolset, either (a) call login({ agentName }) to onboard: relay '
  + 'the returned code and the /activate URL to your user (print the URL bare on '
  + 'its own line), then poll login_status({ handle }) every 5 seconds — respect '
  + 'any slow_down — until approved, and follow the one-time claim recipe to '
  + 'write the credential to a file; then reconnect. Or (b) use your MCP client\'s '
  + 'native OAuth / authenticate action. NEVER move the credential through this '
  + 'conversation: do not print, echo, or paste it. The handle is safe, '
  + 'short-lived transcript residue.';

/**
 * Handle initialize method
 */
function handleInitialize(params, isAnonymous = false) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    capabilities: {
      tools: {},
    },
    instructions: isAnonymous ? ANON_SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS,
  };
}

/**
 * Handle tools/list method
 */
function handleToolsList(isAnonymous = false) {
  return {
    tools: toolListFor(isAnonymous),
  };
}

/**
 * Handle tools/call method
 *
 * Returns MCP tool result format with is_error field for proper error handling.
 * See: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
 */
async function handleToolCall(params, agentToken) {
  const { name, arguments: args } = params;

  if (!name) {
    return {
      is_error: true,
      content: [
        {
          type: 'text',
          text: 'Tool name is required',
        },
      ],
    };
  }

  // Log the action
  if (agentToken.delegationId) {
    try {
      await delegation.logAgentAction(agentToken.delegationId, `tool:${name}`, {
        metadata: { args },
      });
    } catch (err) {
      // Don't fail the request if logging fails
      console.error('Failed to log agent action:', err);
    }
  }

  try {
    const result = await toolRegistry.executeTool(name, args || {}, agentToken);

    return {
      content: toToolResultContent(result),
    };
  } catch (error) {
    // Return error in MCP tool result format with is_error: true
    // This ensures the agent sees detailed error messages instead of generic ones
    console.error(`Tool "${name}" execution error:`, error);
    notifyException(error, { source: 'mcp-tool', extra: { tool: name } });

    return {
      is_error: true,
      content: [
        {
          type: 'text',
          // error.message from executor.js already includes stack trace and hints
          text: error.message,
        },
      ],
    };
  }
}

// ============================================================
// Convenience endpoints for easier testing/debugging
// ============================================================

/**
 * POST /mcp/tools/list - List available tools (convenience endpoint)
 *
 * Anonymous callers see only the two login tools (same filter as JSON-RPC
 * tools/list) — this convenience endpoint previously enumerated the full toolset
 * to anyone; the anonymous surface must not leak the full tool inventory.
 */
router.post('/tools/list', optionalAgentAuth, (req, res) => {
  res.json({
    tools: toolListFor(!req.agentToken),
  });
});

/**
 * POST /mcp/tools/call - Execute a tool (convenience endpoint)
 *
 * Returns MCP tool result format for consistency with the main endpoint.
 */
router.post('/tools/call', anonymousAwareAuth, async (req, res) => {
  try {
    const { name, arguments: args } = req.body;

    if (!name) {
      return res.status(400).json({
        is_error: true,
        content: [{ type: 'text', text: 'Tool name is required' }],
      });
    }

    const isAnonymous = !req.agentToken;
    // Anonymous callers may only invoke the two login tools; everything else
    // gets the byte-identical missing-credential 401 (same as JSON-RPC).
    if (isAnonymous && !toolRegistry.ANON_TOOL_NAMES.includes(name)) {
      return sendMissingChallenge(req, res);
    }

    // Log the action (only when a delegation is present — anonymous calls skip it)
    if (!isAnonymous && req.agentToken.delegationId) {
      try {
        await delegation.logAgentAction(req.agentToken.delegationId, `tool:${name}`, {
          metadata: { args },
        });
      } catch (err) {
        console.error('Failed to log agent action:', err);
      }
    }

    // Build the tool context: baseUrl + clientIp for both, synthetic for anonymous.
    const context = isAnonymous
      ? { isAnonymous: true, baseUrl: buildBaseUrl(req), clientIp: req.ip }
      : Object.assign(req.agentToken, { baseUrl: buildBaseUrl(req), clientIp: req.ip });

    const result = await toolRegistry.executeTool(name, args || {}, context);
    res.json({
      content: toToolResultContent(result),
    });
  } catch (error) {
    console.error('Tool execution error:', error);
    notifyException(error, { req, source: 'mcp-tool' });
    // Return error in MCP tool result format with is_error: true
    res.status(500).json({
      is_error: true,
      content: [
        {
          type: 'text',
          // error.message from executor.js already includes stack trace and hints
          text: error.message,
        },
      ],
    });
  }
});

// ============================================================
// Agent token management endpoints (for testing)
// ============================================================

/**
 * POST /mcp/auth/delegate - Create a delegation and get a token
 * This is a simplified endpoint for testing - in production, use OAuth flow
 */
router.post('/auth/delegate', requireAuth, async (req, res) => {
  try {
    const { userId, agentId, agentName, scopes } = req.body;

    if (!userId || !agentId || !agentName) {
      return res.status(400).json({
        error: 'Missing required fields: userId, agentId, agentName',
      });
    }

    // Ensure users can only create delegations for themselves
    if (req.user.userId !== userId) {
      return res.status(403).json({ error: 'Cannot create delegation for another user' });
    }

    // Create delegation
    const delegationRecord = await delegation.createDelegation(userId, agentId, agentName, {
      scopes: scopes || ['documents:read', 'documents:write'],
    });

    // Generate token
    const token = generateAgentToken(delegationRecord);

    res.json({
      delegation: {
        id: delegationRecord.id,
        userId: delegationRecord.user_id,
        agentId: delegationRecord.agent_id,
        agentName: delegationRecord.agent_name,
        scopes: delegationRecord.scopes,
      },
      token,
    });
  } catch (error) {
    console.error('Delegation error:', error);
    notifyException(error, { req, source: 'mcp' });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /mcp/auth/delegations/:userId - List delegations for a user
 */
router.get('/auth/delegations/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    // Ensure users can only list their own delegations
    if (req.user.userId !== userId) {
      return res.status(403).json({ error: 'Cannot list delegations for another user' });
    }

    const delegations = await delegation.listUserDelegations(userId);
    res.json({ delegations });
  } catch (error) {
    console.error('List delegations error:', error);
    notifyException(error, { req, source: 'mcp' });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /mcp/auth/token - Generate a new token for an existing delegation
 */
router.post('/auth/token', requireAuth, async (req, res) => {
  try {
    const { delegationId } = req.body;

    if (!delegationId) {
      return res.status(400).json({ error: 'delegationId is required' });
    }

    const delegationRecord = await delegation.getDelegation(delegationId);
    if (!delegationRecord) {
      return res.status(404).json({ error: 'Delegation not found' });
    }

    // Verify the authenticated user owns this delegation
    if (delegationRecord.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Not authorized for this delegation' });
    }

    // Check if delegation is still valid
    const check = await delegation.checkDelegation(delegationId);
    if (!check.isValid) {
      return res.status(403).json({ error: check.reason });
    }

    const token = generateAgentToken(delegationRecord);
    res.json({ token });
  } catch (error) {
    console.error('Token generation error:', error);
    notifyException(error, { req, source: 'mcp' });
    res.status(500).json({ error: error.message });
  }
});

module.exports = {
  router,
  oauthRouter,
  init,
  // Exported for the tool-inventory / instruction-budget guard (T017).
  SERVER_INSTRUCTIONS,
  ANON_SERVER_INSTRUCTIONS,
};
