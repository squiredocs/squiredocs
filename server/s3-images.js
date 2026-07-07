/**
 * S3-backed storage for document images.
 *
 * Image bytes live in a dedicated S3 bucket (separate from the DB-backup S3,
 * which uses an s3cmd ConfigMap). Documents store only a short app URL that
 * resolves to a short-lived presigned GET URL, so bytes never sit in the
 * append-only Yjs log and never traverse the app on the read path.
 *
 * Config is read from the environment at module load (same pattern as redis.js):
 *   S3_IMAGE_BUCKET, S3_IMAGE_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
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

const S3_IMAGE_CONFIG = {
  bucket: process.env.S3_IMAGE_BUCKET || '',
  region: process.env.S3_IMAGE_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
};

// How long presigned GET URLs stay valid (seconds).
const GET_URL_TTL_SECONDS = 3600;

let s3Client = null;

/**
 * Whether image storage is configured (bucket + credentials present).
 * @returns {boolean}
 */
function isEnabled() {
  return !!(S3_IMAGE_CONFIG.bucket && S3_IMAGE_CONFIG.accessKeyId && S3_IMAGE_CONFIG.secretAccessKey);
}

/**
 * S3 origin(s) the browser loads presigned image URLs from — for the CSP
 * `img-src` allowlist. Empty when storage isn't configured. Virtual-hosted
 * style (`<bucket>.s3.<region>.amazonaws.com`), which is what the presigner
 * emits for our dotless bucket names.
 * @returns {string[]}
 */
function cspImageSources() {
  if (!isEnabled()) return [];
  return [`https://${S3_IMAGE_CONFIG.bucket}.s3.${S3_IMAGE_CONFIG.region}.amazonaws.com`];
}

/**
 * Get the singleton S3 client. Throws if storage isn't configured.
 * @returns {S3Client}
 */
function getClient() {
  if (!isEnabled()) {
    throw new Error('S3 image storage not configured (set S3_IMAGE_BUCKET + AWS credentials)');
  }
  if (!s3Client) {
    s3Client = new S3Client({
      region: S3_IMAGE_CONFIG.region,
      credentials: {
        accessKeyId: S3_IMAGE_CONFIG.accessKeyId,
        secretAccessKey: S3_IMAGE_CONFIG.secretAccessKey,
      },
    });
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
    Bucket: S3_IMAGE_CONFIG.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    // Bytes for a given key never change; let the browser cache aggressively.
    CacheControl: 'private, max-age=31536000, immutable',
  }));
}

/**
 * Fetch an object's bytes (used for agent vision over doc images).
 * @param {string} key - S3 object key
 * @returns {Promise<Buffer>} Object bytes
 */
async function getObject(key) {
  const res = await getClient().send(new GetObjectCommand({
    Bucket: S3_IMAGE_CONFIG.bucket,
    Key: key,
  }));
  // Node stream → Buffer
  const chunks = [];
  for await (const chunk of res.Body) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Generate a short-lived presigned GET URL for an object.
 * @param {string} key - S3 object key
 * @returns {Promise<string>} Presigned URL
 */
async function getSignedGetUrl(key) {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: S3_IMAGE_CONFIG.bucket, Key: key }),
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
  await getClient().send(new CopyObjectCommand({
    Bucket: S3_IMAGE_CONFIG.bucket,
    // Our keys are uuid/hyphen/slash only, so no URL-encoding concerns.
    CopySource: `${S3_IMAGE_CONFIG.bucket}/${sourceKey}`,
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
    Bucket: S3_IMAGE_CONFIG.bucket,
    Delete: { Objects: keys.map((Key) => ({ Key })) },
  }));
}

module.exports = {
  isEnabled,
  cspImageSources,
  putObject,
  getObject,
  copyObject,
  getSignedGetUrl,
  deleteObjects,
  GET_URL_TTL_SECONDS,
};
