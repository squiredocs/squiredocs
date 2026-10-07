/**
 * Image storage facade (feature 058, contracts/storage-and-boot.md).
 *
 * Every module that stores, reads, copies, signs, or deletes image bytes
 * requires this file, never a driver (a guard test enforces it). The driver is
 * chosen by the instance config's storageDriver (STORAGE_DRIVER, else s3 when
 * S3_IMAGE_BUCKET is set, else local) at each call, so callers never know
 * which one is active and a test can switch drivers by resetting the config.
 *
 *   kind                      'local' | 's3'
 *   isEnabled()               boolean
 *   cspImageSources()         origins for CSP img-src
 *   putObject({ key, body, contentType })
 *   getObject(key)            Buffer
 *   readObject(key)           { body, contentType }
 *   getSignedGetUrl(key)      s3 only; the local driver throws (branch on kind)
 *   copyObject(src, dst)
 *   deleteObjects(keys)
 *   GET_URL_TTL_SECONDS       3600
 *
 * A missing object rejects with code 'NoSuchKey' and an unsafe key with code
 * 'InvalidKey', for both drivers.
 */
const { getInstanceConfig } = require('../instance-config');
const s3Driver = require('./s3-driver');
const { createLocalDriver } = require('./local-driver');

const localDrivers = new Map();

function localDriverFor(dataDir) {
  let d = localDrivers.get(dataDir);
  if (!d) {
    d = createLocalDriver({ dataDir });
    localDrivers.set(dataDir, d);
  }
  return d;
}

/** The active driver for the current instance config. */
function current() {
  const config = getInstanceConfig();
  return config.storageDriver === 's3' ? s3Driver : localDriverFor(config.dataDir);
}

module.exports = {
  get kind() { return current().kind; },
  isEnabled: () => current().isEnabled(),
  cspImageSources: () => current().cspImageSources(),
  putObject: (args) => current().putObject(args),
  getObject: (key) => current().getObject(key),
  readObject: (key) => current().readObject(key),
  getSignedGetUrl: (key) => current().getSignedGetUrl(key),
  copyObject: (src, dst) => current().copyObject(src, dst),
  deleteObjects: (keys) => current().deleteObjects(keys),
  GET_URL_TTL_SECONDS: 3600,
  /** The active driver object (tests and diagnostics). */
  current,
};
