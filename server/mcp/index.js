/**
 * MCP Server Router
 *
 * Implements the Model Context Protocol for AI agent access.
 * Uses Streamable HTTP transport with JSON-RPC style messages.
 */
const express = require('express');
const { requireAgentAuth, requireScope, optionalAgentAuth } = require('./auth/middleware');
const { requireAuth } = require('../auth/middleware');
const { generateAgentToken } = require('./auth/jwt');
const delegation = require('./auth/delegation');
const registeredAgents = require('./auth/registered-agents');
const oauthFlow = require('./auth/oauth-flow');
const oauthRouter = require('./auth/oauth-router');
const apiTokens = require('./auth/api-tokens');
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
  toolRegistry.init(persistence);
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
    },
  });
});

/**
 * POST /mcp - Main MCP message endpoint
 * Handles JSON-RPC style messages
 * Requires authentication for all operations
 */
router.post('/', requireAgentAuth, async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;

  // Log all MCP requests for debugging
  console.log(`[MCP] ${method} - authenticated: ${!!req.agentToken}`);

  // Validate JSON-RPC format
  if (jsonrpc !== '2.0') {
    return res.json(jsonRpcError(id, INVALID_REQUEST, 'Invalid JSON-RPC version'));
  }

  try {
    let result;

    switch (method) {
      case 'initialize':
        result = handleInitialize(params);
        break;

      case 'tools/list':
        result = handleToolsList();
        break;

      case 'tools/call':
        result = await handleToolCall(params, req.agentToken);
        break;

      case 'ping':
        result = {};
        break;

      default:
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

/**
 * Handle initialize method
 */
function handleInitialize(params) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    capabilities: {
      tools: {},
    },
  };
}

/**
 * Handle tools/list method
 */
function handleToolsList() {
  return {
    tools: toolRegistry.getToolList(),
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
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
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
 */
router.post('/tools/list', (req, res) => {
  res.json({
    tools: toolRegistry.getToolList(),
  });
});

/**
 * POST /mcp/tools/call - Execute a tool (convenience endpoint)
 *
 * Returns MCP tool result format for consistency with the main endpoint.
 */
router.post('/tools/call', requireAgentAuth, async (req, res) => {
  try {
    const { name, arguments: args } = req.body;

    if (!name) {
      return res.status(400).json({
        is_error: true,
        content: [{ type: 'text', text: 'Tool name is required' }],
      });
    }

    // Log the action
    if (req.agentToken.delegationId) {
      try {
        await delegation.logAgentAction(req.agentToken.delegationId, `tool:${name}`, {
          metadata: { args },
        });
      } catch (err) {
        console.error('Failed to log agent action:', err);
      }
    }

    // Add baseUrl to agentToken for tools that need to construct URLs
    req.agentToken.baseUrl = buildBaseUrl(req);

    const result = await toolRegistry.executeTool(name, args || {}, req.agentToken);
    res.json({
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
};
