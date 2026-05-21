const { runCycle } = require('./cleanWorker');
const { shouldRunRetention, deleteOldRawMessages } = require('./retentionCleanup');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RETENTION_DAYS = 7; // Keep raw messages for 7 days

/** @type {number|null} */
let timer = null;
/** @type {boolean} */
let running = false;

/**
 * Start the cleaning worker on a 5-minute interval.
 * Also runs retention cleanup once per day (delete old raw messages).
 * @param {{ intervalMs?: number, retentionDays?: number }} [options]
 */
function start(options = {}) {
  if (running) return;
  running = true;

  const intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
  const retentionDays = options.retentionDays || RETENTION_DAYS;

  // Run once immediately on startup
  runCycle();

  // Run retention cleanup on startup if needed
  checkAndRunRetention(retentionDays);

  timer = setInterval(() => {
    runCycle();
    checkAndRunRetention(retentionDays);
  }, intervalMs);

  // Unref so it doesn't keep the process alive
  if (timer.unref) timer.unref();

  console.log(`[cleaning] Worker started (every ${intervalMs / 1000}s, retention: ${retentionDays} days)`);
}

/**
 * Check if retention cleanup should run and execute if needed.
 * @param {number} retentionDays
 */
async function checkAndRunRetention(retentionDays) {
  const shouldRun = await shouldRunRetention();
  if (shouldRun) {
    console.log('[cleaning] Running daily retention cleanup...');
    const result = await deleteOldRawMessages(retentionDays);
    if (result.deleted > 0) {
      console.log(`[cleaning] Retention cleanup complete: deleted ${result.deleted} raw messages`);
    }
  }
}

/**
 * Stop the cleaning worker.
 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
}

module.exports = { start, stop };
