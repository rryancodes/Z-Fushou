const { LIVE_CONFIG } = require('../live.config');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

/**
 * Verify external dependencies are reachable before starting the engine.
 * Throws on first failure — the engine does not start partially.
 *
 * Checks Supabase, Qdrant, and Redis only.
 * Cloudflare is NOT checked — a temporary hiccup should not block startup.
 * The first real message will naturally test the embedding endpoint.
 */
async function checkDependencies() {
  const errors = [];

  // 1. Supabase
  try {
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { error } = await db
      .from('community_messages_clean')
      .select('id')
      .limit(1);

    if (error) throw error;
    logger.info('Health', 'Supabase reachable');
  } catch (err) {
    errors.push(`Supabase: ${err.message}`);
  }

  // 2. Qdrant
  try {
    const res = await fetch(
      `${process.env.QDRANT_URL.replace(/\/$/, '')}/collections/${LIVE_CONFIG.QDRANT_COLLECTION}`,
      { headers: { 'api-key': process.env.QDRANT_API_KEY } }
    );
    // 200 = exists, 404 = will be created on startup — both are fine
    if (!res.ok && res.status !== 404) {
      const body = await res.text();
      throw new Error(`${res.status} ${body.slice(0, 200)}`);
    }
    logger.info('Health', 'Qdrant reachable');
  } catch (err) {
    errors.push(`Qdrant: ${err.message}`);
  }

  // 3. Redis (required for distributed lock)
  try {
    const { default: Redis } = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    await redis.ping();
    redis.disconnect();
    logger.info('Health', 'Redis reachable');
  } catch (err) {
    errors.push(`Redis: ${err.message}`);
  }

  if (errors.length > 0) {
    throw new Error(`Health check failed — engine will not start:\n  ${errors.join('\n  ')}`);
  }

  logger.info('Health', 'All dependencies healthy');
}

module.exports = { checkDependencies };
