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
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
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
  putObject,
  getSignedGetUrl,
  deleteObjects,
  GET_URL_TTL_SECONDS,
};
