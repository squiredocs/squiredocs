/**
 * S3 driver for image storage (moved from server/s3-images.js, feature 058).
 *
 * Image bytes live in a dedicated S3 bucket (separate from the DB-backup S3,
 * which uses an s3cmd ConfigMap). Documents store only a short app URL that
 * resolves to a short-lived presigned GET URL, so bytes never sit in the
 * append-only Yjs log and never traverse the app on the read path.
 *
 * Only server/image-storage/index.js may require this file; every consumer
 * goes through the facade (a guard test enforces it).
 *
 * Config comes from the instance config (server/instance-config.js), read at
 * call time: S3_IMAGE_BUCKET, S3_IMAGE_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, and S3_ENDPOINT. With S3_ENDPOINT set (MinIO, R2,
 * ...) the client uses that endpoint with path-style addressing, and the CSP
 * image origin is the endpoint's origin, because that is where the presigned
 * URLs point.
 */
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { Buffer } = require('buffer');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getInstanceConfig } = require('../instance-config');

// How long presigned GET URLs stay valid (seconds).
const GET_URL_TTL_SECONDS = 3600;

let s3Client = null;
let s3ClientConfig = null;

function settings() {
  return getInstanceConfig().s3;
}

/**
 * Whether image storage is configured (bucket + credentials present).
 * @returns {boolean}
 */
function isEnabled() {
  const c = settings();
  return !!(c.bucket && c.accessKeyId && c.secretAccessKey);
}

/**
 * Origin(s) the browser loads presigned image URLs from, for the CSP
 * `img-src` allowlist. Empty when storage isn't configured. Without an
 * endpoint: virtual-hosted style (`<bucket>.s3.<region>.amazonaws.com`), which
 * is what the presigner emits for our dotless bucket names. With S3_ENDPOINT:
 * the endpoint origin (path-style URLs).
 * @returns {string[]}
 */
function cspImageSources() {
  if (!isEnabled()) return [];
  const c = settings();
  if (c.endpoint) return [c.endpoint];
  return [`https://${c.bucket}.s3.${c.region}.amazonaws.com`];
}

/**
 * Get the singleton S3 client. Throws if storage isn't configured.
 * @returns {S3Client}
 */
function getClient() {
  if (!isEnabled()) {
    throw new Error('S3 image storage not configured (set S3_IMAGE_BUCKET + AWS credentials)');
  }
  const c = settings();
  if (!s3Client || s3ClientConfig !== c) {
    const opts = {
      region: c.region,
      credentials: {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
      },
    };
    if (c.endpoint) {
      opts.endpoint = c.endpoint;
      opts.forcePathStyle = true;
    }
    s3Client = new S3Client(opts);
    s3ClientConfig = c;
  }
  return s3Client;
}

/**
 * Upload an object to the image bucket.
 * @param {object} args
 * @param {string} args.key - S3 object key
 * @param {Buffer} args.body - Object bytes
 * @param {string} args.contentType - MIME type
 * @returns {Promise<void>}
 */
async function putObject({ key, body, contentType }) {
  await getClient().send(new PutObjectCommand({
    Bucket: settings().bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    // Bytes for a given key never change; let the browser cache aggressively.
    CacheControl: 'private, max-age=31536000, immutable',
  }));
}

async function bodyToBuffer(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch an object's bytes (used for agent vision over doc images).
 * @param {string} key - S3 object key
 * @returns {Promise<Buffer>} Object bytes
 */
async function getObject(key) {
  const res = await getClient().send(new GetObjectCommand({
    Bucket: settings().bucket,
    Key: key,
  }));
  return bodyToBuffer(res.Body);
}

/**
 * Fetch an object's bytes and stored content type (raw image routes).
 * @param {string} key - S3 object key
 * @returns {Promise<{ body: Buffer, contentType: string|null }>}
 */
async function readObject(key) {
  const res = await getClient().send(new GetObjectCommand({
    Bucket: settings().bucket,
    Key: key,
  }));
  return { body: await bodyToBuffer(res.Body), contentType: res.ContentType || null };
}

/**
 * Generate a short-lived presigned GET URL for an object.
 * @param {string} key - S3 object key
 * @returns {Promise<string>} Presigned URL
 */
async function getSignedGetUrl(key) {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: settings().bucket, Key: key }),
    { expiresIn: GET_URL_TTL_SECONDS }
  );
}

/**
 * Server-side copy of an object to a new key (bytes never traverse the app).
 * Content-Type and Cache-Control carry over (S3 metadata directive COPY).
 * @param {string} sourceKey - Existing S3 object key
 * @param {string} destKey - New S3 object key
 * @returns {Promise<void>}
 */
async function copyObject(sourceKey, destKey) {
  const bucket = settings().bucket;
  await getClient().send(new CopyObjectCommand({
    Bucket: bucket,
    // Our keys are uuid/hyphen/slash only, so no URL-encoding concerns.
    CopySource: `${bucket}/${sourceKey}`,
    Key: destKey,
  }));
}

/**
 * Delete objects by key (best-effort; used when a document is deleted).
 * @param {string[]} keys - S3 object keys
 * @returns {Promise<void>}
 */
async function deleteObjects(keys) {
  if (!keys || keys.length === 0) return;
  await getClient().send(new DeleteObjectsCommand({
    Bucket: settings().bucket,
    Delete: { Objects: keys.map((Key) => ({ Key })) },
  }));
}

module.exports = {
  kind: 's3',
  isEnabled,
  cspImageSources,
  putObject,
  getObject,
  readObject,
  copyObject,
  getSignedGetUrl,
  deleteObjects,
  GET_URL_TTL_SECONDS,
};
