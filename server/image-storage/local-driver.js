/**
 * Local filesystem driver for image storage (feature 058, research R7,
 * data-model section 3).
 *
 *   <dataDir>/images/objects/<key>        bytes, exactly as uploaded
 *   <dataDir>/images/meta/<key>.json      {"contentType":"image/png"}
 *
 * <key> is the existing opaque storage key (document_images.s3_key, or
 * chat-attachments/<userId>/<uuid>); slashes become directories. A key that is
 * empty, absolute, contains NUL or a backslash, or resolves outside objects/
 * (or meta/) is rejected with code 'InvalidKey' before any filesystem call.
 * A missing object rejects with code 'NoSuchKey', the same code the S3 SDK
 * uses, so callers map it to 404 without knowing the driver.
 *
 * Writes go to a temp file in the target directory, then rename, so a reader
 * never sees a partial object. Files are 0640, directories 0750.
 *
 * Only server/image-storage/index.js may require this file.
 *
 * Single node: the bytes live on this instance's volume. More than one replica
 * needs a shared data volume, or STORAGE_DRIVER=s3 (RBD-058-31).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureDir } = require('../fs-ensure-dir');

function storageError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.name = code;
  return err;
}

/**
 * Create a driver rooted at `<dataDir>/images`.
 * @param {object} opts
 * @param {string} opts.dataDir - absolute path
 * @param {object} [opts.log=console]
 */
function createLocalDriver({ dataDir, log = console }) {
  const root = path.join(dataDir, 'images');
  const objectsRoot = path.join(root, 'objects');
  const metaRoot = path.join(root, 'meta');
  let enabled = null;

  function resolveUnder(base, key, suffix = '') {
    if (typeof key !== 'string' || key.length === 0 || key.includes('\0') || key.includes('\\') || path.isAbsolute(key)) {
      throw storageError('InvalidKey', `Invalid storage key: ${JSON.stringify(key)}`);
    }
    const full = path.resolve(base, key + suffix);
    const rel = path.relative(base, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw storageError('InvalidKey', `Invalid storage key: ${JSON.stringify(key)}`);
    }
    return full;
  }

  const objectPath = (key) => resolveUnder(objectsRoot, key);
  const metaPath = (key) => resolveUnder(metaRoot, key, '.json');

  /** Usable when the images directory can be created and written. Checked once, logged once. */
  function isEnabled() {
    if (enabled !== null) return enabled;
    try {
      ensureDir(objectsRoot);
      ensureDir(metaRoot);
      fs.accessSync(objectsRoot, fs.constants.W_OK);
      fs.accessSync(metaRoot, fs.constants.W_OK);
      enabled = true;
    } catch (err) {
      enabled = false;
      (log.warn || log.log).call(log, `[Storage] local image storage at ${root} is not writable: ${err.message}`);
    }
    return enabled;
  }

  async function writeAtomic(target, data) {
    ensureDir(path.dirname(target));
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fsp.writeFile(tmp, data, { mode: 0o640, flag: 'wx' });
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  function mapMissing(err, key) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return storageError('NoSuchKey', `No such object: ${key}`);
    }
    return err;
  }

  async function putObject({ key, body, contentType }) {
    const obj = objectPath(key);
    const meta = metaPath(key);
    await writeAtomic(obj, body);
    await writeAtomic(meta, JSON.stringify({ contentType: contentType || null }));
  }

  async function getObject(key) {
    const obj = objectPath(key);
    try {
      return await fsp.readFile(obj);
    } catch (err) {
      throw mapMissing(err, key);
    }
  }

  async function readContentType(key) {
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath(key), 'utf8'));
      return typeof meta.contentType === 'string' ? meta.contentType : null;
    } catch {
      return null;
    }
  }

  async function readObject(key) {
    const body = await getObject(key);
    return { body, contentType: await readContentType(key) };
  }

  async function copyObject(sourceKey, destKey) {
    const srcObj = objectPath(sourceKey);
    const dstObj = objectPath(destKey);
    const dstMeta = metaPath(destKey);
    let bytes;
    try {
      bytes = await fsp.readFile(srcObj);
    } catch (err) {
      throw mapMissing(err, sourceKey);
    }
    const contentType = await readContentType(sourceKey);
    await writeAtomic(dstObj, bytes);
    await writeAtomic(dstMeta, JSON.stringify({ contentType }));
  }

  async function deleteObjects(keys) {
    if (!keys || keys.length === 0) return;
    for (const key of keys) {
      for (const p of [objectPath(key), metaPath(key)]) {
        try {
          await fsp.unlink(p);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
    }
  }

  async function getSignedGetUrl() {
    throw new Error('Local image storage has no presigned URLs; serve the raw route instead');
  }

  return {
    kind: 'local',
    root,
    isEnabled,
    cspImageSources: () => [],
    putObject,
    getObject,
    readObject,
    copyObject,
    deleteObjects,
    getSignedGetUrl,
    GET_URL_TTL_SECONDS: 3600,
  };
}

module.exports = { createLocalDriver };
