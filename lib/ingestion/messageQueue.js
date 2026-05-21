/**
 * In-memory message queue for batch ingestion.
 *
 * Messages are pushed in and drained by the batch writer.
 * Access is synchronized via a drain lock so concurrent flushes never happen.
 */

/** @type {Array<object>} */
let queue = [];

/** @type {boolean} */
let draining = false;

/** @type {number} */
let highWaterMark = 0;

/**
 * Push a structured message into the queue.
 * @param {object} message
 * @returns {number} current queue length
 */
function push(message) {
  queue.push(message);
  if (queue.length > highWaterMark) {
    highWaterMark = queue.length;
  }
  return queue.length;
}

/**
 * Drain all messages from the queue atomically.
 * Returns null if a drain is already in progress (prevents concurrent flushes).
 * @returns {Array<object>|null}
 */
function drain() {
  if (draining) return null;
  draining = true;
  const batch = queue;
  queue = [];
  return batch;
}

/**
 * Release the drain lock after a flush completes (success or failure).
 */
function releaseDrain() {
  draining = false;
}

/**
 * Get current queue length.
 * @returns {number}
 */
function size() {
  return queue.length;
}

/**
 * Get the high water mark (peak queue size ever seen).
 * Useful for monitoring / logging.
 * @returns {number}
 */
function getHighWaterMark() {
  return highWaterMark;
}

/**
 * Reset the queue (used in tests).
 */
function reset() {
  queue = [];
  draining = false;
  highWaterMark = 0;
}

module.exports = { push, drain, releaseDrain, size, getHighWaterMark, reset };
