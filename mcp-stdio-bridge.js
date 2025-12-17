#!/usr/bin/env node
/**
 * MCP stdio bridge
 *
 * This script acts as an MCP stdio server that forwards requests
 * to the HTTP-based MCP API at the production server.
 */
const https = require('https');
const http = require('http');
const readline = require('readline');

const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3001';
const MCP_TOKEN = process.env.MCP_TOKEN;

if (!MCP_TOKEN) {
  console.error('Error: MCP_TOKEN environment variable is required');
  process.exit(1);
}

// Parse URL
const serverUrl = new URL(MCP_SERVER_URL);
const isHttps = serverUrl.protocol === 'https:';
const httpModule = isHttps ? https : http;

// Create readline interface for stdio
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// Log to stderr for debugging
function log(...args) {
  console.error('[mcp-bridge]', ...args);
}

/**
 * Make HTTP request to MCP server
 */
function makeRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: serverUrl.hostname,
      port: serverUrl.port || (isHttps ? 443 : 80),
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MCP_TOKEN}`,
      },
    };

    const req = httpModule.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
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

/**
 * Handle MCP request
 */
async function handleRequest(message) {
  try {
    const { method, params } = message;

    log('Received request:', method);

    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'collab-editor',
            version: '1.0.0',
          },
        };

      case 'tools/list':
        const toolsResult = await makeRequest('POST', '/tools/list', {});
        return { tools: toolsResult.tools };

      case 'tools/call':
        const { name, arguments: args } = params;
        const callResult = await makeRequest('POST', '/tools/call', {
          name,
          arguments: args,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(callResult.result, null, 2),
            },
          ],
        };

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  } catch (error) {
    log('Error handling request:', error.message);
    throw error;
  }
}

/**
 * Send JSON-RPC response
 */
function sendResponse(id, result, error) {
  const response = {
    jsonrpc: '2.0',
    id,
  };

  if (error) {
    response.error = {
      code: -32603,
      message: error.message || String(error),
    };
  } else {
    response.result = result;
  }

  console.log(JSON.stringify(response));
}

// Process incoming messages
let buffer = '';

rl.on('line', async (line) => {
  buffer += line;

  try {
    const message = JSON.parse(buffer);
    buffer = '';

    const { id, method, params } = message;

    try {
      const result = await handleRequest(message);
      sendResponse(id, result);
    } catch (error) {
      sendResponse(id, null, error);
    }
  } catch (e) {
    // Not a complete JSON object yet, keep buffering
  }
});

rl.on('close', () => {
  process.exit(0);
});

log('MCP stdio bridge started');
log('Server URL:', MCP_SERVER_URL);
