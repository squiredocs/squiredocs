#!/usr/bin/env node
/**
 * Test MCP Bridge with authenticated calls
 */
require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');

// Get token from server
async function getToken() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      userId: process.env.TEST_USER_ID,
      agentId: 'claude-test:bridge',
      agentName: 'Bridge Test',
    });

    const req = http.request(
      {
        hostname: 'localhost',
        port: 3001,
        path: '/mcp/auth/delegate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(body).token);
          } else {
            reject(new Error(`Failed to get token: ${body}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Get user ID
async function getUserId() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3001,
        path: '/mcp/tools/call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      () => {}
    );
    req.on('error', () => {});
    req.end();

    // Use the delegate endpoint to discover a user ID
    // For now, just use a placeholder - in production you'd get this from auth
    resolve(process.env.TEST_USER_ID || '10937127-083d-4359-b0be-6c1390878780');
  });
}

async function testBridge(token) {
  return new Promise((resolve, reject) => {
    const bridge = spawn('node', ['mcp-server.js'], {
      env: {
        ...process.env,
        MCP_TOKEN: token,
        MCP_SERVER_URL: 'http://localhost:3001',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    bridge.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    bridge.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    bridge.on('close', (code) => {
      console.log('\n=== Bridge stderr (logs) ===');
      console.log(stderr);
      console.log('\n=== Bridge stdout (responses) ===');
      stdout.split('\n').forEach((line) => {
        if (line.trim()) {
          try {
            console.log(JSON.stringify(JSON.parse(line), null, 2));
          } catch {
            console.log(line);
          }
        }
      });
      resolve();
    });

    // Send test messages
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_documents', arguments: {} },
      },
    ];

    messages.forEach((msg) => {
      bridge.stdin.write(JSON.stringify(msg) + '\n');
    });

    // Close stdin to signal end
    setTimeout(() => {
      bridge.stdin.end();
    }, 100);
  });
}

async function main() {
  try {
    console.log('🧪 Testing MCP Bridge with Authentication\n');

    // First, get a user ID - for this test we'll use the dev user
    const userId = await getUserId();
    console.log(`User ID: ${userId}`);

    // Create delegation and get token via HTTP API
    console.log('Creating delegation...');

    const data = JSON.stringify({
      userId: userId,
      agentId: 'claude-test:bridge-test',
      agentName: 'Bridge Test Agent',
    });

    const tokenResponse = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: 3001,
          path: '/mcp/auth/delegate',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    if (tokenResponse.status !== 200) {
      throw new Error(`Failed to create delegation: ${tokenResponse.body}`);
    }

    const { token } = JSON.parse(tokenResponse.body);
    console.log(`Token: ${token.substring(0, 50)}...`);

    console.log('\nTesting bridge...\n');
    await testBridge(token);

    console.log('\n✅ Test completed!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
