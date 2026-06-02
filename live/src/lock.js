const { randomUUID } = require('crypto');
const logger = require('./logger');

const LOCK_KEY = 'live_engine:lock';
const LOCK_TIMEOUT_MS = 60 * 1000; // 60 seconds

let redisClient = null;
let ownerToken = null;

/**
 * Connect to Redis. Throws if REDIS_URL is missing.
 */
async function initRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required for the live engine distributed lock');
  }

  const { default: Redis } = require('ioredis');
  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    },
  });

  redisClient.on('error', (err) => {
    logger.warn('Lock', 'Redis connection error', { error: err.message });
  });

  await redisClient.ping();
  logger.info('Lock', 'Redis connected');
}

/**
 * Try to grab the lock. Sets a random UUID as the value so we can
 * verify ownership on refresh and release.
 * Returns true if we got it, false if someone else holds it.
 */
async function acquireLock() {
  if (!redisClient) {
    throw new Error('Redis not initialized — call initRedis() first');
  }

  ownerToken = randomUUID();
  const result = await redisClient.set(LOCK_KEY, ownerToken, 'PX', LOCK_TIMEOUT_MS, 'NX');
  const acquired = result === 'OK';
  if (acquired) {
    logger.info('Lock', 'Lock acquired', { key: LOCK_KEY, owner: ownerToken });
  } else {
    ownerToken = null;
    logger.warn('Lock', 'Lock already held by another instance', { key: LOCK_KEY });
  }
  return acquired;
}

/**
 * Refresh the lock timeout. Called once per tick (~15s).
 * Checks that we still own it before extending — if another worker
 * grabbed it after our timeout expired, we back off immediately.
 * Returns true if refreshed, false if we lost ownership.
 */
async function refreshLock() {
  if (!redisClient || !ownerToken) return false;
  try {
    const currentValue = await redisClient.get(LOCK_KEY);
    if (currentValue !== ownerToken) {
      logger.error('Lock', 'Lock no longer belongs to us — another instance took over');
      return false;
    }
    const result = await redisClient.pexpire(LOCK_KEY, LOCK_TIMEOUT_MS);
    if (!result) {
      logger.error('Lock', 'Failed to refresh lock timeout');
      return false;
    }
    return true;
  } catch (err) {
    logger.error('Lock', 'Failed to refresh lock', { error: err.message });
    return false;
  }
}

/**
 * Release the lock. Only deletes if we still own it.
 */
async function releaseLock() {
  if (!redisClient || !ownerToken) return;
  try {
    const currentValue = await redisClient.get(LOCK_KEY);
    if (currentValue === ownerToken) {
      await redisClient.del(LOCK_KEY);
      logger.info('Lock', 'Lock released');
    } else {
      logger.warn('Lock', 'Lock no longer ours — skipping release');
    }
    ownerToken = null;
  } catch (err) {
    logger.warn('Lock', 'Failed to release lock', { error: err.message });
  }
}

/**
 * Disconnect from Redis.
 */
async function close() {
  if (redisClient) {
    redisClient.disconnect();
    redisClient = null;
  }
  ownerToken = null;
}

module.exports = {
  initRedis,
  acquireLock,
  refreshLock,
  releaseLock,
  close,
};
