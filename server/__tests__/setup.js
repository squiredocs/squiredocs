// Jest setup file for server tests - runs before each test file
const path = require('path');
const fs = require('fs');

// Cleanup test directories before tests
const testDataDir = path.join(__dirname, '../../test-data');
if (fs.existsSync(testDataDir)) {
  fs.rmSync(testDataDir, { recursive: true, force: true });
}

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // Use random port for tests
process.env.DATABASE_URL = 'postgresql://localhost/collab_test_db';
