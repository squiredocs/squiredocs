#!/usr/bin/env node
/**
 * Generate MCP Agent Token
 *
 * This script generates an agent token for testing MCP integration.
 * It creates a delegation for the specified user and outputs a JWT token
 * that can be used to authenticate with the MCP server.
 *
 * Usage:
 *   node script/generate-mcp-token.js [user-email]
 *
 * If no email is provided, it will use the dev test user.
 */

require('dotenv').config();

const { Pool } = require('pg');

// Set MCP secret if not already set
if (!process.env.MCP_JWT_SECRET) {
  process.env.MCP_JWT_SECRET = 'dev-mcp-secret-change-in-production';
}

const delegation = require('../server/mcp/auth/delegation');
const { generateAgentToken } = require('../server/mcp/auth/jwt');

// Database configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  try {
    // Initialize delegation module
    delegation.init(pool);

    // Get user email from args or use default
    const userEmail = process.argv[2] || 'dev@test.local';

    console.log(`\n🔍 Looking for user: ${userEmail}\n`);

    // Find the user
    const userResult = await pool.query(
      'SELECT id, email, name FROM users WHERE LOWER(email) = LOWER($1)',
      [userEmail]
    );

    if (userResult.rows.length === 0) {
      console.error(`❌ User not found: ${userEmail}`);
      console.error('\nAvailable users:');
      const allUsers = await pool.query('SELECT email, name FROM users LIMIT 10');
      allUsers.rows.forEach((u) => console.log(`  - ${u.email} (${u.name})`));
      process.exit(1);
    }

    const user = userResult.rows[0];
    console.log(`✅ Found user: ${user.name} (${user.email})`);
    console.log(`   User ID: ${user.id}\n`);

    // Create or update delegation for Claude Code
    const agentId = 'claude-code:local-dev';
    const agentName = 'Claude Code (Local Development)';
    const scopes = ['documents:read', 'documents:write'];

    console.log(`📝 Creating delegation for ${agentName}...`);

    const delegationRecord = await delegation.createDelegation(user.id, agentId, agentName, {
      scopes,
    });

    console.log(`✅ Delegation created!`);
    console.log(`   Delegation ID: ${delegationRecord.id}`);
    console.log(`   Scopes: ${scopes.join(', ')}\n`);

    // Generate token
    const token = generateAgentToken(delegationRecord);

    console.log('═'.repeat(60));
    console.log('\n🔑 AGENT TOKEN (copy this):\n');
    console.log(token);
    console.log('\n' + '═'.repeat(60));

    console.log('\n📋 To use with the MCP server:\n');
    console.log('1. Add this header to your requests:');
    console.log(`   Authorization: Bearer ${token.substring(0, 50)}...`);
    console.log('\n2. Or use the token in the query string:');
    console.log(`   ?token=${token.substring(0, 50)}...`);

    console.log('\n📡 MCP Endpoints:');
    console.log('   GET  http://localhost:3001/mcp           - Server info');
    console.log('   POST http://localhost:3001/mcp           - JSON-RPC messages');
    console.log('   POST http://localhost:3001/mcp/tools/list - List tools');
    console.log('   POST http://localhost:3001/mcp/tools/call - Execute tool');

    console.log('\n🧪 Test with curl:');
    console.log(`
curl -X POST http://localhost:3001/mcp/tools/list

curl -X POST http://localhost:3001/mcp/tools/call \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${token.substring(0, 30)}..." \\
  -d '{"name": "list_documents", "arguments": {}}'
`);

    // Output JSON for easy parsing
    console.log('\n📦 JSON output (for scripts):');
    console.log(
      JSON.stringify(
        {
          userId: user.id,
          userEmail: user.email,
          delegationId: delegationRecord.id,
          agentId,
          scopes,
          token,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
