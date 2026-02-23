// Jest setup file for server tests - runs before each test file
const path = require('path');
const fs = require('fs');
const { getTestDatabaseUrl } = require('./helpers/db');

// Cleanup test directories before tests
const testDataDir = path.join(__dirname, '../../test-data');
if (fs.existsSync(testDataDir)) {
  fs.rmSync(testDataDir, { recursive: true, force: true });
}

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // Use random port for tests
// Ensure DATABASE_URL points to the test database
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = getTestDatabaseUrl();
}
