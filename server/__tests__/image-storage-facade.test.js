/**
 * Feature 058 (T031): driver selection through the facade, and a guard that
 * nothing outside server/image-storage/ requires a driver (or the deleted
 * s3-images module).
 */
const { execFileSync } = require('child_process');
const path = require('path');
const storage = require('../image-storage');
const { _resetInstanceConfigForTests } = require('../instance-config');

const REPO = path.resolve(__dirname, '../..');
const saved = { STORAGE_DRIVER: process.env.STORAGE_DRIVER, S3_IMAGE_BUCKET: process.env.S3_IMAGE_BUCKET };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetInstanceConfigForTests();
});

function configure(vars) {
  delete process.env.STORAGE_DRIVER;
  delete process.env.S3_IMAGE_BUCKET;
  Object.assign(process.env, vars);
  _resetInstanceConfigForTests();
}

test('auto-detect: local without a bucket, s3 with one', () => {
  configure({});
  expect(storage.kind).toBe('local');
  expect(storage.current().kind).toBe('local');
  configure({ S3_IMAGE_BUCKET: 'b' });
  expect(storage.kind).toBe('s3');
});

test('explicit STORAGE_DRIVER wins', () => {
  configure({ STORAGE_DRIVER: 'local', S3_IMAGE_BUCKET: 'b' });
  expect(storage.kind).toBe('local');
  configure({ STORAGE_DRIVER: 's3' });
  expect(storage.kind).toBe('s3');
  expect(storage.isEnabled()).toBe(false);
});

test('the local driver follows SQUIRE_DATA_DIR (the per-worker temp dir in tests)', () => {
  configure({ STORAGE_DRIVER: 'local' });
  expect(storage.current().root).toBe(path.join(process.env.SQUIRE_DATA_DIR, 'images'));
  expect(storage.isEnabled()).toBe(true);
  expect(storage.cspImageSources()).toEqual([]);
});

function gitGrep(pattern, pathspecs) {
  try {
    return execFileSync('git', ['grep', '-l', '-E', pattern, '--', ...pathspecs], { cwd: REPO, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return []; // no match
    throw err;
  }
}

test('no module outside the facade requires a driver file', () => {
  const hits = gitGrep('image-storage/(s3|local)-driver', [
    'server', ':!server/image-storage/**', ':!server/**/__tests__/**', ':!server/__tests__/**',
  ]);
  expect(hits).toEqual([]);
});

test('nothing requires the deleted server/s3-images module', () => {
  const hits = gitGrep("(require|jest\\.mock|jest\\.doMock)\\(['\"][./]*(server/)?s3-images['\"]", ['server', '__tests__', 'script']);
  expect(hits).toEqual([]);
});
