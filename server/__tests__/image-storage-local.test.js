/**
 * Feature 058 (T029): server/image-storage/local-driver.js against a temp data
 * directory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalDriver } = require('../image-storage/local-driver');

const quietLog = () => ({ warn: jest.fn(), log: jest.fn() });

let dataDir;
let driver;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-local-images-'));
  driver = createLocalDriver({ dataDir, log: quietLog() });
});
afterEach(() => {
  try { fs.chmodSync(dataDir, 0o700); } catch { /* ignore */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('put, get, readObject round-trip with the content type', async () => {
  expect(driver.isEnabled()).toBe(true);
  await driver.putObject({ key: 'doc-1/img-1', body: PNG, contentType: 'image/png' });
  expect(await driver.getObject('doc-1/img-1')).toEqual(PNG);
  expect(await driver.readObject('doc-1/img-1')).toEqual({ body: PNG, contentType: 'image/png' });
  expect(fs.readFileSync(path.join(dataDir, 'images/objects/doc-1/img-1'))).toEqual(PNG);
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'images/meta/doc-1/img-1.json'), 'utf8')))
    .toEqual({ contentType: 'image/png' });
  expect(fs.statSync(path.join(dataDir, 'images/objects/doc-1/img-1')).mode & 0o777).toBe(0o640);
});

test('copyObject copies bytes and content type', async () => {
  await driver.putObject({ key: 'a/1', body: PNG, contentType: 'image/webp' });
  await driver.copyObject('a/1', 'b/2');
  expect(await driver.readObject('b/2')).toEqual({ body: PNG, contentType: 'image/webp' });
  expect(await driver.getObject('a/1')).toEqual(PNG);
});

test('deleteObjects removes objects and ignores missing keys', async () => {
  await driver.putObject({ key: 'a/1', body: PNG, contentType: 'image/png' });
  await driver.deleteObjects(['a/1', 'never/existed']);
  await expect(driver.getObject('a/1')).rejects.toMatchObject({ code: 'NoSuchKey' });
  expect(fs.existsSync(path.join(dataDir, 'images/meta/a/1.json'))).toBe(false);
  await expect(driver.deleteObjects([])).resolves.toBeUndefined();
  await expect(driver.deleteObjects(undefined)).resolves.toBeUndefined();
});

test('a missing object rejects with NoSuchKey (get, read, copy source)', async () => {
  await expect(driver.getObject('nope/1')).rejects.toMatchObject({ code: 'NoSuchKey' });
  await expect(driver.readObject('nope/1')).rejects.toMatchObject({ code: 'NoSuchKey' });
  await expect(driver.copyObject('nope/1', 'x/1')).rejects.toMatchObject({ code: 'NoSuchKey' });
});

describe('key safety', () => {
  const BAD = ['', '/abs', '/etc/passwd', '../x', 'a/../../x', 'a\\b', 'a\0b', '..', 'a/..'];

  test.each(BAD)('rejects %j with InvalidKey and touches nothing outside images/', async (key) => {
    const outsideBefore = fs.readdirSync(dataDir).sort();
    await expect(driver.putObject({ key, body: PNG, contentType: 'image/png' })).rejects.toMatchObject({ code: 'InvalidKey' });
    await expect(driver.getObject(key)).rejects.toMatchObject({ code: 'InvalidKey' });
    await expect(driver.readObject(key)).rejects.toMatchObject({ code: 'InvalidKey' });
    await expect(driver.copyObject('ok/1', key)).rejects.toMatchObject({ code: expect.stringMatching(/InvalidKey|NoSuchKey/) });
    await expect(driver.copyObject(key, 'ok/2')).rejects.toMatchObject({ code: 'InvalidKey' });
    await expect(driver.deleteObjects([key])).rejects.toMatchObject({ code: 'InvalidKey' });
    expect(fs.readdirSync(dataDir).sort()).toEqual(outsideBefore);
    expect(fs.existsSync(path.join(dataDir, 'x'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(dataDir), 'x'))).toBe(false);
  });

  test('a key with an inner .. that stays inside is allowed', async () => {
    await driver.putObject({ key: 'a/../b', body: PNG, contentType: 'image/png' });
    expect(await driver.getObject('b')).toEqual(PNG);
  });
});

test('isEnabled is false (logged once) when the directory cannot be created', () => {
  const log = quietLog();
  // Root ignores mode bits, so use a data dir whose parent is a regular file.
  const blocker = path.join(dataDir, 'file');
  fs.writeFileSync(blocker, 'x');
  const d = createLocalDriver({ dataDir: path.join(blocker, 'data'), log });
  expect(d.isEnabled()).toBe(false);
  expect(d.isEnabled()).toBe(false);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.warn.mock.calls[0][0]).toMatch(/^\[Storage\] local image storage at .* is not writable: /);
});

test('cspImageSources is empty and getSignedGetUrl throws', async () => {
  expect(driver.cspImageSources()).toEqual([]);
  await expect(driver.getSignedGetUrl('a/1')).rejects.toThrow(/raw route/);
  expect(driver.kind).toBe('local');
});

test('bytes survive a fresh driver over the same directory (restart)', async () => {
  await driver.putObject({ key: 'doc/img', body: PNG, contentType: 'image/gif' });
  const again = createLocalDriver({ dataDir, log: quietLog() });
  expect(await again.readObject('doc/img')).toEqual({ body: PNG, contentType: 'image/gif' });
});
