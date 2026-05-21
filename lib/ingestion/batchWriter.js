const { push: queuePush, drain, releaseDrain, size, reset: resetQueue } = require('./messageQueue');
const { bulkInsertMessages, setCheckpoints } = require('./supabaseClient');

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 10_000; // 10 seconds
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;

/** @type {number|null} */
let flushTimer = null;
/** @type {number} */
let batchSize;
/** @type {number} */
let flushIntervalMs;
/** @type {boolean} */
let running = false;

/**
 * Extract per-channel latest message_id from a batch.
 * @param {Array<object>} messages
 * @returns {Object<string, string>} { channelId: lastMessageId }
 */
function extractCheckpoints(messages) {
  const map = {};
  for (const m of messages) {
    const cid = m.channel_id;
    // Discord snowflake IDs are chronologically ordered — highest = latest
    if (!map[cid] || m.message_id > map[cid]) {
      map[cid] = m.message_id;
    }
  }
  return map;
}

/**
 * Sleep helper for retry backoff.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Attempt a single batch flush with retries.
 * @param {Array<object>} batch
 */
async function flushBatch(batch) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = await bulkInsertMessages(batch);

    if (!result.error) {
      // Update checkpoints for all channels in this batch
      const checkpoints = extractCheckpoints(batch);
      await setCheckpoints(checkpoints);
      return;
    }

    const delay = BASE_DELAY_MS * Math.pow(2, attempt);
    console.error(
      `[ingestion:batchWriter] Flush failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${result.error}. Retrying in ${delay}ms`
    );
    await sleep(delay);
  }

  // All retries exhausted — log but don't crash.
  // Messages are already drained from queue, so they are lost.
  // In production you'd write to a dead-letter queue here.
  console.error(
    `[ingestion:batchWriter] FATAL: batch of ${batch.length} messages lost after ${MAX_RETRIES} retries`
  );
}

/**
 * Flush the queue. Respects drain lock to prevent concurrent flushes.
 */
async function flush() {
  const batch = drain();
  if (!batch || batch.length === 0) {
    if (batch !== null) releaseDrain();
    return;
  }

  try {
    await flushBatch(batch);
  } finally {
    releaseDrain();
  }
}

/**
 * Start the periodic flush timer and size-based flush check.
 * @param {{ batchSize?: number, flushIntervalMs?: number }} [options]
 */
function start(options = {}) {
  if (running) return;
  running = true;
  batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  flushIntervalMs = options.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS;

  // Periodic flush
  flushTimer = setInterval(() => {
    flush().catch(err => {
      console.error('[ingestion:batchWriter] Periodic flush error:', err.message);
    });
  }, flushIntervalMs);

  // Unref timer so it doesn't keep the process alive
  if (flushTimer.unref) flushTimer.unref();

  // Size-based flush: check after every push
  // We monkey-patch the queue module's push to add threshold check
  const originalPush = queuePush;
  // We export a wrapped push below
}

/**
 * Push a message and trigger flush if threshold is reached.
 * @param {object} message
 */
function pushAndMaybeFlush(message) {
  const currentSize = queuePush(message);
  if (currentSize >= batchSize) {
    // Fire-and-forget — don't block the caller
    flush().catch(err => {
      console.error('[ingestion:batchWriter] Threshold flush error:', err.message);
    });
  }
}

/**
 * Stop the batch writer timer.
 */
function stop() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  running = false;
}

/**
 * Force an immediate flush (e.g., on shutdown).
 * @returns {Promise<void>}
 */
async function forceFlush() {
  await flush();
}

/**
 * Get current settings (for tests).
 */
function getSettings() {
  return { batchSize, flushIntervalMs, running };
}

/**
 * Reset state (for tests).
 */
function reset() {
  stop();
  resetQueue();
  batchSize = DEFAULT_BATCH_SIZE;
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
  running = false;
}

module.exports = {
  pushAndMaybeFlush,
  flush,
  forceFlush,
  start,
  stop,
  getSettings,
  reset,
  // Export internals for testing
  _extractCheckpoints: extractCheckpoints,
};
