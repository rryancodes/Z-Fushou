const { LIVE_CONFIG } = require('../live.config');
const metrics = require('./metrics');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, options = {}) {
  const retries = options.retries || LIVE_CONFIG.RETRY_COUNT;
  const baseDelayMs = options.baseDelayMs || LIVE_CONFIG.RETRY_BASE_MS;
  const stage = options.stage || 'unknown';
  const logger = options.logger;
  const context = options.context || {};

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (logger) {
        logger.warn(stage, `Attempt ${attempt}/${retries} failed — ${error.message}`, {
          ...context,
          error: error.message,
        });
      }
      metrics.increment('retryCount');
      if (attempt === retries && options.failureMetric) {
        metrics.increment(options.failureMetric);
      }

      if (attempt === retries) {
        throw error;
      }

      const jitter = Math.floor(Math.random() * 100);
      await sleep(baseDelayMs * Math.pow(2, attempt - 1) + jitter);
    }
  }

  throw new Error(`Retry loop exhausted for ${stage}`);
}

module.exports = { sleep, withRetry };
