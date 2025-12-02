#!/usr/bin/env node

/**
 * Database initialization script
 * Creates the database (if needed) and runs migrations
 */

const { Pool } = require('pg');
const { execSync } = require('child_process');

// Setup DATABASE_URL from env vars if needed
require('./setup-db-env.js');

const POSTGRES_CONFIG = process.env.DATABASE_URL || {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
};

async function initDatabase() {
  console.log('Initializing PostgreSQL database for Yjs persistence...');
  
  try {
    // First, check if database exists, create if it doesn't
    const adminPool = new Pool({
      host: typeof POSTGRES_CONFIG === 'string' ? undefined : POSTGRES_CONFIG.host,
      port: typeof POSTGRES_CONFIG === 'string' ? undefined : POSTGRES_CONFIG.port,
      database: 'postgres', // Connect to default database
      user: typeof POSTGRES_CONFIG === 'string' ? undefined : POSTGRES_CONFIG.user,
      password: typeof POSTGRES_CONFIG === 'string' ? undefined : POSTGRES_CONFIG.password,
    });

    const dbName = typeof POSTGRES_CONFIG === 'string' 
      ? POSTGRES_CONFIG.split('/').pop()?.split('?')[0] || 'collab_db'
      : POSTGRES_CONFIG.database;

    try {
      const result = await adminPool.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [dbName]
      );

      if (result.rows.length === 0) {
        console.log(`Creating database: ${dbName}...`);
        await adminPool.query(`CREATE DATABASE ${dbName}`);
        console.log(`✓ Database ${dbName} created`);
      } else {
        console.log(`✓ Database ${dbName} already exists`);
      }
    } catch (error) {
      // Database might already exist, continue
      if (error.code !== '42P04') {
        throw error;
      }
    }

    await adminPool.end();

    // Run migrations using node-pg-migrate CLI
    console.log('\nRunning database migrations...');
    execSync('npx node-pg-migrate up', { stdio: 'inherit' });
    
    console.log('\n✓ Database initialization completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('✗ Error initializing database:', error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('\nMake sure PostgreSQL is running and accessible.');
      console.error('Connection details:', typeof POSTGRES_CONFIG === 'string' ? 'See DATABASE_URL' : POSTGRES_CONFIG);
    } else if (error.code === '28P01') {
      console.error('\nAuthentication failed. Please check your database credentials.');
    }
    
    process.exit(1);
  }
}

initDatabase();

