#!/usr/bin/env node

/**
 * Helper script to set DATABASE_URL from individual env vars
 * This allows node-pg-migrate to work with individual DB config vars
 */

// Build DATABASE_URL from individual env vars if not already set
if (!process.env.DATABASE_URL) {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const database = process.env.DB_NAME || 'collab_db';
  const user = process.env.DB_USER || process.env.USER || 'postgres';
  const password = process.env.DB_PASSWORD || '';
  
  // Format DATABASE_URL (password can be empty for local dev)
  const auth = password ? `${user}:${password}@` : `${user}@`;
  process.env.DATABASE_URL = `postgres://${auth}${host}:${port}/${database}`;
}

