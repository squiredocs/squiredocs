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

// Feature 058: normalize the instance configuration every suite starts from.
// The app-dev pod sets SQUIRE_HOSTED=true (RBD-058-28) and may carry S3 and
// SES variables; a suite must never inherit them by accident, or it would test
// the hosted branch while claiming to test the default, or write image bytes
// to a real bucket. A suite that needs hosted behavior sets SQUIRE_HOSTED
// itself before requiring modules (and calls _resetInstanceConfigForTests).
for (const name of [
  'SQUIRE_HOSTED', 'APP_URL', 'STORAGE_DRIVER', 'S3_ENDPOINT', 'MIGRATE_ON_BOOT',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
]) {
  delete process.env[name];
}
// Each worker (and each test-file process) gets its own throwaway data
// directory, so a suite that forgets to mock image storage writes local-driver
// bytes here, never to /data or another worker's files (RBD-058-19).
{
  const os = require('os');
  const squireDataDir = path.join(os.tmpdir(), `squire-test-data-w${getWorkerId()}-${process.pid}`);
  fs.mkdirSync(squireDataDir, { recursive: true });
  process.env.SQUIRE_DATA_DIR = squireDataDir;
  // afterAll rather than process.on('exit'): Jest hands each test file a fresh
  // process proxy, so an exit listener per file would pile up in one worker.
  // Files in a worker run serially, and the next file's setup recreates it.
  afterAll(() => {
    try { fs.rmSync(squireDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
