const Y = require('yjs');
const { getRedisClient, isRedisEnabled, isRedisReady } = require('./redis');

// Redis key prefix for Yjs documents
const DOC_KEY_PREFIX = 'yjs:doc:';

// TTL for documents in Redis (24 hours) - documents are refreshed on access
const DOC_TTL_SECONDS = 24 * 60 * 60;

/**
 * Redis persistence adapter for Yjs documents
 * Provides fast document loading/saving using Redis as a cache layer
 */
class RedisPersistence {
  constructor() {
    this.enabled = isRedisEnabled();
  }

  /**
   * Get the Redis key for a document
   * @param {string} docGuid - Document GUID
   * @returns {string} Redis key
   */
  _getDocKey(docGuid) {
    return DOC_KEY_PREFIX + docGuid;
  }

  /**
   * Store a Y.Doc state in Redis
   * @param {string} docGuid - Document GUID
   * @param {Y.Doc} ydoc - Yjs document
   * @returns {Promise<void>}
   */
  async storeDoc(docGuid, ydoc) {
    if (!this.enabled) return;

    try {
      const redis = getRedisClient();
      const state = Y.encodeStateAsUpdate(ydoc);
      const key = this._getDocKey(docGuid);

      await redis.setex(key, DOC_TTL_SECONDS, Buffer.from(state));
    } catch (err) {
      console.error(`[RedisPersistence] Error storing doc ${docGuid}:`, err.message);
    }
  }

  /**
   * Store a Y.Doc state update in Redis (replaces existing state)
   * @param {string} docGuid - Document GUID
   * @param {Uint8Array} state - Encoded Y.Doc state
   * @returns {Promise<void>}
   */
  async storeDocState(docGuid, state) {
    if (!this.enabled) return;

    try {
      const redis = getRedisClient();
      const key = this._getDocKey(docGuid);

      await redis.setex(key, DOC_TTL_SECONDS, Buffer.from(state));
    } catch (err) {
      console.error(`[RedisPersistence] Error storing doc state ${docGuid}:`, err.message);
    }
  }

  /**
   * Load a Y.Doc from Redis
   * @param {string} docGuid - Document GUID
   * @returns {Promise<Y.Doc|null>} Y.Doc if found, null otherwise
   */
  async getDoc(docGuid) {
    if (!this.enabled) return null;

    try {
      const redis = getRedisClient();
      const key = this._getDocKey(docGuid);

      const data = await redis.getBuffer(key);
      if (!data) return null;

      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, new Uint8Array(data));

      // Refresh TTL on access
      await redis.expire(key, DOC_TTL_SECONDS);

      return ydoc;
    } catch (err) {
      console.error(`[RedisPersistence] Error loading doc ${docGuid}:`, err.message);
      return null;
    }
  }

  /**
   * Check if a document exists in Redis
   * @param {string} docGuid - Document GUID
   * @returns {Promise<boolean>}
   */
  async hasDoc(docGuid) {
    if (!this.enabled) return false;

    try {
      const redis = getRedisClient();
      const key = this._getDocKey(docGuid);
      return (await redis.exists(key)) === 1;
    } catch (err) {
      console.error(`[RedisPersistence] Error checking doc ${docGuid}:`, err.message);
      return false;
    }
  }

  /**
   * Delete a document from Redis
   * @param {string} docGuid - Document GUID
   * @returns {Promise<void>}
   */
  async deleteDoc(docGuid) {
    if (!this.enabled) return;

    try {
      const redis = getRedisClient();
      const key = this._getDocKey(docGuid);
      await redis.del(key);
    } catch (err) {
      console.error(`[RedisPersistence] Error deleting doc ${docGuid}:`, err.message);
    }
  }

  /**
   * Check if Redis is enabled and ready
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled && isRedisReady();
  }
}

// Singleton instance
const redisPersistence = new RedisPersistence();

module.exports = { RedisPersistence, redisPersistence };
