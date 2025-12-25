const Redis = require('ioredis');

// Redis connection configuration
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  maxRetriesPerRequest: 3,
  connectTimeout: 5000,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
};

// Singleton Redis client
let redisClient = null;
let connectionReady = false;

/**
 * Get the Redis client instance (singleton)
 * Connects eagerly when first called.
 * @returns {Redis} Redis client
 */
function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis(REDIS_CONFIG);

    redisClient.on('connect', () => {
      console.log('[Redis] Connected to', REDIS_CONFIG.host + ':' + REDIS_CONFIG.port);
    });

    redisClient.on('ready', () => {
      connectionReady = true;
      console.log('[Redis] Ready');
    });

    redisClient.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    redisClient.on('close', () => {
      connectionReady = false;
      console.log('[Redis] Connection closed');
    });
  }
  return redisClient;

}

/**
 * Check if Redis connection is ready
 * @returns {boolean}
 */
function isRedisReady() {
  return connectionReady;
}

/**
 * Check if Redis is enabled (REDIS_HOST is set)
 * @returns {boolean}
 */
function isRedisEnabled() {
  return !!process.env.REDIS_HOST;
}

/**
 * Close the Redis connection
 * @returns {Promise<void>}
 */
async function closeRedis() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

// Initialize Redis connection eagerly if enabled
if (isRedisEnabled()) {
  getRedisClient();
}

module.exports = {
  getRedisClient,
  isRedisEnabled,
  isRedisReady,
  closeRedis,
};
