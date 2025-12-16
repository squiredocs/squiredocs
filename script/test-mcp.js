#!/usr/bin/env node
/**
 * Test MCP endpoints
 */
require('dotenv').config();
const { Pool } = require('pg');
const http = require('http');

// Set MCP secret
if (!process.env.MCP_JWT_SECRET) {
  process.env.MCP_JWT_SECRET = 'dev-mcp-secret-change-in-production';
}

const delegation = require('../server/mcp/auth/delegation');
const { generateAgentToken } = require('../server/mcp/auth/jwt');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function main() {
  try {
    delegation.init(pool);

    console.log('🧪 Testing MCP Server\n');

    // Test 1: Server info
    console.log('1. Testing GET /mcp (server info)...');
    const serverInfo = await httpRequest({
      hostname: 'localhost',
      port: 3001,
      path: '/mcp',
      method: 'GET',
    });
    console.log(`   Status: ${serverInfo.status}`);
    console.log(`   Response: ${serverInfo.body}\n`);

    // Test 2: List tools
    console.log('2. Testing POST /mcp/tools/list...');
    const toolsList = await httpRequest(
      {
        hostname: 'localhost',
        port: 3001,
        path: '/mcp/tools/list',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({})
    );
    console.log(`   Status: ${toolsList.status}`);
    const tools = JSON.parse(toolsList.body);
    console.log(`   Tools available: ${tools.tools.map((t) => t.name).join(', ')}\n`);

    // Test 3: Call tool without auth (should fail)
    console.log('3. Testing POST /mcp/tools/call without auth (should fail)...');
    const noAuth = await httpRequest(
      {
        hostname: 'localhost',
        port: 3001,
        path: '/mcp/tools/call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({ name: 'list_documents', arguments: {} })
    );
    console.log(`   Status: ${noAuth.status} (expected 401)`);
    console.log(`   Response: ${noAuth.body}\n`);

    // Test 4: Create delegation and call tool
    console.log('4. Testing authenticated tool call...');

    // Get dev user
    const userResult = await pool.query("SELECT id FROM users WHERE email = 'dev@test.local'");
    if (userResult.rows.length === 0) {
      console.log('   ❌ No dev user found. Create one first.');
      return;
    }
    const userId = userResult.rows[0].id;
    console.log(`   User ID: ${userId}`);

    // Create delegation
    const del = await delegation.createDelegation(userId, 'claude-code:mcp-test', 'MCP Test', {
      scopes: ['documents:read', 'documents:write'],
    });
    console.log(`   Delegation ID: ${del.id}`);

    // Generate token
    const token = generateAgentToken(del);
    console.log(`   Token generated (${token.length} chars)`);

    // Call list_documents
    const authCall = await httpRequest(
      {
        hostname: 'localhost',
        port: 3001,
        path: '/mcp/tools/call',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      JSON.stringify({ name: 'list_documents', arguments: {} })
    );
    console.log(`   Status: ${authCall.status}`);
    console.log(`   Response: ${authCall.body}\n`);

    // Test 5: JSON-RPC style call
    console.log('5. Testing JSON-RPC style POST /mcp...');
    const jsonRpc = await httpRequest(
      {
        hostname: 'localhost',
        port: 3001,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })
    );
    console.log(`   Status: ${jsonRpc.status}`);
    console.log(`   Response: ${jsonRpc.body}\n`);

    console.log('✅ All tests completed!');
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

main();
