const { handleMessage, setChannels } = require('./messageListener');
const { start: startWriter, stop: stopWriter, forceFlush, pushAndMaybeFlush } = require('./batchWriter');
const { backfill } = require('./ingestionCheckpoint');

/**
 * Initialize the message ingestion system.
 *
 * 1. Read configured channels from INGESTION_CHANNELS env var
 * 2. Backfill missed messages from last checkpoint
 * 3. Start the batch writer
 *
 * @param {import('discord.js').Client} client
 * @param {{ batchSize?: number, flushIntervalMs?: number }} [options]
 */
async function init(client, options = {}) {
  // Read channel list from env var — comma-separated string
  const channelIds = (process.env.INGESTION_CHANNELS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!channelIds.length) {
    console.log('[ingestion] No channels configured — ingestion disabled');
    return;
  }

  setChannels(channelIds);
  console.log(`[ingestion] Watching ${channelIds.length} channel(s): ${channelIds.join(', ')}`);

  // Backfill missed messages from last checkpoint
  const backfilled = await backfill(client, channelIds);
  if (backfilled.length) {
    for (const msg of backfilled) {
      pushAndMaybeFlush(msg);
    }
    console.log(`[ingestion] Queued ${backfilled.length} backfilled messages`);
  }

  // Start periodic + threshold-based batch writer
  startWriter(options);
  console.log('[ingestion] Batch writer started');
}

/**
 * Shutdown hook — flush remaining messages before exit.
 * @returns {Promise<void>}
 */
async function shutdown() {
  console.log('[ingestion] Shutting down — flushing remaining messages');
  await forceFlush();
  stopWriter();
  console.log('[ingestion] Shutdown complete');
}

module.exports = { init, shutdown, handleMessage };
