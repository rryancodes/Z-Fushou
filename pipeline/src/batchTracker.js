const logger = require('./logger');
const { PIPELINE_CONFIG } = require('../pipeline.config');

let redisClient = null;
let degraded = false;

/**
 * Initialize Redis connection. Fails gracefully into degraded mode.
 */
async function initRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.warn('batchTracker', 'REDIS_URL not set — running in degraded mode (no distributed lock, no dedup)');
    degraded = true;
    return;
  }

  try {
    // Use ioredis if available (project uses bullmq which depends on it), otherwise raw socket
    // bullmq already pulls in ioredis, so we can use it directly
    const { default: Redis } = require('ioredis');
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 200, 2000);
      },
    });

    redisClient.on('error', (err) => {
      logger.warn('batchTracker', 'Redis connection error', { error: err.message });
    });

    // Test connection
    await redisClient.ping();
    logger.info('batchTracker', 'Redis connected');
  } catch (err) {
    logger.warn('batchTracker', 'Redis unavailable — running in degraded mode', { error: err.message });
    degraded = true;
    redisClient = null;
  }
}

/**
 * Try to acquire distributed lock. Returns true if acquired, false if already held.
 * In degraded mode, always returns true (no lock).
 */
async function acquireLock() {
  if (degraded || !redisClient) return true;

  const key = PIPELINE_CONFIG.LOCK_KEY;
  const ttl = PIPELINE_CONFIG.LOCK_TTL_SECONDS;
  const result = await redisClient.set(key, 'locked', 'PX', ttl * 1000, 'NX');
  return result === 'OK';
}

/**
 * Release the distributed lock. No-op in degraded mode.
 */
async function releaseLock() {
  if (degraded || !redisClient) return;
  try {
    await redisClient.del(PIPELINE_CONFIG.LOCK_KEY);
  } catch (err) {
    logger.warn('batchTracker', 'Failed to release lock', { error: err.message });
  }
}

/**
 * Get the last successful batch info from Redis.
 * Returns { batchId, endTimestamp } or null.
 */
async function getLastBatch() {
  if (degraded || !redisClient) return null;
  try {
    const raw = await redisClient.get(PIPELINE_CONFIG.LAST_BATCH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('batchTracker', 'Failed to read last batch', { error: err.message });
    return null;
  }
}

/**
 * Save last successful batch info.
 * @param {string} batchId
 * @param {string} endTimestamp
 */
async function setLastBatch(batchId, endTimestamp) {
  if (degraded || !redisClient) return;
  try {
    await redisClient.set(
      PIPELINE_CONFIG.LAST_BATCH_KEY,
      JSON.stringify({ batchId, endTimestamp }),
      'EX', 7 * 24 * 3600, // 7 days TTL
    );
  } catch (err) {
    logger.warn('batchTracker', 'Failed to save last batch', { error: err.message });
  }
}

/**
 * Record batch status.
 * @param {string} batchId
 * @param {'running'|'done'|'failed'} status
 * @param {string} [startedAt]
 * @param {string} [finishedAt]
 */
async function setBatchStatus(batchId, status, startedAt, finishedAt) {
  if (degraded || !redisClient) return;
  try {
    const key = `${PIPELINE_CONFIG.BATCH_STATUS_KEY_PREFIX}${batchId}`;
    await redisClient.set(
      key,
      JSON.stringify({ batchId, status, startedAt, finishedAt }),
      'EX', 24 * 3600, // 1 day TTL
    );
  } catch (err) {
    logger.warn('batchTracker', 'Failed to set batch status', { error: err.message });
  }
}

/**
 * Check if a batch ID was already processed successfully.
 */
async function isBatchProcessed(batchId) {
  if (degraded || !redisClient) return false;
  try {
    const key = `${PIPELINE_CONFIG.BATCH_STATUS_KEY_PREFIX}${batchId}`;
    const raw = await redisClient.get(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed.status === 'done';
  } catch (err) {
    return false;
  }
}

/**
 * Close Redis connection (for clean shutdown).
 */
async function close() {
  if (redisClient) {
    redisClient.disconnect();
    redisClient = null;
  }
}

module.exports = {
  initRedis,
  acquireLock,
  releaseLock,
  getLastBatch,
  setLastBatch,
  setBatchStatus,
  isBatchProcessed,
  close,
  isDegraded: () => degraded,
};
