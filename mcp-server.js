#!/usr/bin/env node
/**
 * MCP Server Bridge for Claude Code
 *
 * This is a stdio-based MCP server that proxies requests to the
 * collab-editor HTTP API. Run this locally and configure Claude
 * to use it as an MCP server.
 *
 * Usage:
 *   1. Generate a token: node script/generate-mcp-token.js [email]
 *   2. Set environment variables:
 *      export MCP_TOKEN="your-token-here"
 *      export MCP_SERVER_URL="http://localhost:3001"  # optional
 *   3. Run: node mcp-server.js
 *
 * Or configure in Claude's MCP settings with env vars.
 */

const http = require('http');
const https = require('https');
const readline = require('readline');

// Configuration from environment
const MCP_TOKEN = process.env.MCP_TOKEN;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3001';

// Parse server URL
const serverUrl = new URL(MCP_SERVER_URL);
const isHttps = serverUrl.protocol === 'https:';
const httpModule = isHttps ? https : http;

// Log to stderr (stdout is for MCP protocol)
function log(...args) {
  console.error('[MCP Bridge]', ...args);
}

// Make HTTP request to the collab server
function apiRequest(path, method = 'POST', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: serverUrl.hostname,
      port: serverUrl.port || (isHttps ? 443 : 80),
      path: `/mcp${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (MCP_TOKEN) {
      options.headers['Authorization'] = `Bearer ${MCP_TOKEN}`;
    }

    const req = httpModule.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: { error: data } });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Handle MCP protocol messages
async function handleMessage(message) {
  const { jsonrpc, id, method, params } = message;

  if (jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'Invalid JSON-RPC version' },
    };
  }

  try {
    let result;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          serverInfo: {
            name: 'collab-editor-mcp-bridge',
            version: '1.0.0',
          },
          capabilities: {
            tools: {},
          },
        };
        break;

      case 'initialized':
        // Client acknowledgment, no response needed
        return null;

      case 'tools/list':
        const toolsResponse = await apiRequest('/tools/list', 'POST', {});
        if (toolsResponse.status === 200) {
          result = toolsResponse.data;
        } else {
          throw new Error(toolsResponse.data.error || 'Failed to list tools');
        }
        break;

      case 'tools/call':
        if (!MCP_TOKEN) {
          throw new Error('MCP_TOKEN environment variable not set');
        }
        const callResponse = await apiRequest('/tools/call', 'POST', {
          name: params.name,
          arguments: params.arguments || {},
        });
        if (callResponse.status === 200) {
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(callResponse.data, null, 2),
              },
            ],
          };
        } else {
          throw new Error(callResponse.data.error || 'Tool call failed');
        }
        break;

      case 'ping':
        result = {};
        break;

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown method: ${method}` },
        };
    }

    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  } catch (error) {
    log('Error handling message:', error.message);
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: error.message },
    };
  }
}

// Main stdio loop
async function main() {
  log('Starting MCP bridge server...');
  log('Server URL:', MCP_SERVER_URL);
  log('Token:', MCP_TOKEN ? `${MCP_TOKEN.substring(0, 20)}...` : 'NOT SET');

  if (!MCP_TOKEN) {
    log('WARNING: MCP_TOKEN not set. Tool calls will fail.');
    log('Generate a token with: node script/generate-mcp-token.js');
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Track pending operations
  let pendingOps = 0;
  let closed = false;

  const checkExit = () => {
    if (closed && pendingOps === 0) {
      log('All operations complete, exiting');
      process.exit(0);
    }
  };

  rl.on('line', async (line) => {
    pendingOps++;
    try {
      const message = JSON.parse(line);
      log('Received:', message.method, message.id ? `(id: ${message.id})` : '');

      const response = await handleMessage(message);

      if (response) {
        log('Sending response for:', message.method);
        console.log(JSON.stringify(response));
      }
    } catch (error) {
      log('Parse error:', error.message);
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        })
      );
    } finally {
      pendingOps--;
      checkExit();
    }
  });

  rl.on('close', () => {
    log('Connection closed');
    closed = true;
    checkExit();
  });

  log('Ready. Waiting for messages on stdin...');
}

main().catch((error) => {
  log('Fatal error:', error);
  process.exit(1);
});
