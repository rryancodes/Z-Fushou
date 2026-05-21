const { randomUUID } = require('crypto');
const logger = require('./logger');
const { PIPELINE_CONFIG } = require('../pipeline.config');

/**
 * Step 3: Build context blocks from segments.
 * Context blocks never cross segment boundaries.
 *
 * @param {Array<{segmentIndex: number, messages: Array, boundaryScore: number|null}>} segments
 * @returns {Array<{contextBlockId: string, anchorMessageId: string, segmentIndex: number, segmentBoundaryScore: number|null, contextText: string, messageIds: string[], startTimestamp: string, endTimestamp: string, channelId: string}>}
 */
function buildContextBlocks(segments) {
  const windowSize = PIPELINE_CONFIG.CONTEXT_WINDOW_SIZE;
  const allBlocks = [];

  for (const segment of segments) {
    const { messages, segmentIndex, boundaryScore } = segment;
    if (messages.length === 0) continue;

    for (let i = 0; i < messages.length; i++) {
      // Window start: max(0, i - windowSize + 1)
      const windowStart = Math.max(0, i - windowSize + 1);
      const windowMessages = messages.slice(windowStart, i + 1);

      // Build context text using exact schema column names: username, content
      const lines = windowMessages.map(m => `${m.username}: ${m.content}`);
      const contextText = lines.join('\n');

      // Anchor is the last message in the window (message at index i)
      const anchor = windowMessages[windowMessages.length - 1];

      allBlocks.push({
        contextBlockId: randomUUID(),
        anchorMessageId: anchor.message_id, // exact column name from schema
        segmentIndex,
        segmentBoundaryScore: boundaryScore,
        contextText,
        messageIds: windowMessages.map(m => m.message_id),
        startTimestamp: windowMessages[0].timestamp,
        endTimestamp: anchor.timestamp,
        channelId: anchor.channel_id,
      });
    }
  }

  logger.info('contextBuilder', `Built ${allBlocks.length} context blocks`, {
    segmentCount: segments.length,
  });

  return allBlocks;
}

module.exports = { buildContextBlocks };
