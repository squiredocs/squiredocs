// Jest setup file for server tests - runs before each test file
const path = require('path');
const fs = require('fs');
const { getTestDatabaseUrl, getWorkerId } = require('./helpers/db');

// Cleanup test directories before tests
const testDataDir = path.join(__dirname, '../../test-data');
if (fs.existsSync(testDataDir)) {
  fs.rmSync(testDataDir, { recursive: true, force: true });
}

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // Use random port for tests
// The dev-only auth-bypass routes (/auth/dev-login, /auth/dev-onboarding-reset)
// are gated behind this explicit positive opt-in (fail-closed) — they are NOT
// mounted without it. Enable it for the test suite so the dev-login tests run.
// (Set at require time, before routes.js is required, because the routes are
// registered at module-load time.)
process.env.ENABLE_DEV_ENDPOINTS = '1';
// Point DATABASE_URL at THIS worker's database (feature 052), unconditionally.
// An externally supplied DATABASE_URL is a BASE, not a target, so overwriting it
// is the point: any module that reads process.env.DATABASE_URL directly instead
// of going through helpers/db.js becomes correctly isolated for free.
process.env.DATABASE_URL = getTestDatabaseUrl();

// Give this worker its own Redis logical database (worker N → DB N). DB 0 is
// left to non-test consumers such as a dev server sharing this Redis. Read at
// require-time by server/redis.js, which is loaded later by the test file, so
// setting it here (setupFilesAfterEnv) is early enough.
process.env.REDIS_DB = String(getWorkerId());
