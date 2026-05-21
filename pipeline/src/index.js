const { randomUUID } = require('crypto');

// Load .env for local development (safe no-op on Railway where vars are injected)
try { require('dotenv').config(); } catch { }

const { PIPELINE_CONFIG } = require('../pipeline.config');
const logger = require('./logger');
const batchTracker = require('./batchTracker');
const { fetchMessages, groupMessagesByDate } = require('./fetchMessages');
const { detectBoundariesPipeline } = require('./boundaryDetection');
const { classifyPipeline } = require('./classifier');
const { storeSegmentClassifications } = require('./storeResults');
const { buildContextBlocks } = require('./contextBuilder');
const { embedContextBlocks } = require('./embedder');
const qdrantClient = require('./qdrantClient');

/**
 * Validate required environment variables at startup.
 */
function validateEnv() {
  const missing = PIPELINE_CONFIG.REQUIRED_ENV_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      `See pipeline/README.md for setup instructions.`
    );
  }
}

/**
 * Best-effort: embed context blocks and upsert to Qdrant for retrieval.
 * Non-blocking — failures are logged but do not crash the pipeline.
 */
async function bestEffortEmbedAndIndex(segments) {
  try {
    const contextBlocks = buildContextBlocks(segments);
    if (contextBlocks.length === 0) {
      logger.info('orchestrator', 'No context blocks for Qdrant indexing');
      return;
    }

    const embeddedBlocks = await embedContextBlocks(contextBlocks);
    const validBlocks = embeddedBlocks.filter(b => !b.embeddingFailed);
    if (validBlocks.length === 0) {
      logger.warn('orchestrator', 'All embeddings failed — skipping Qdrant indexing');
      return;
    }

    const batchId = 'embed-' + randomUUID();
    await qdrantClient.upsertBlocks(validBlocks, batchId);

    logger.info('orchestrator', 'Qdrant indexing complete', {
      contextBlockCount: validBlocks.length,
      embeddingFailures: embeddedBlocks.length - validBlocks.length,
    });
  } catch (err) {
    // Non-blocking: log and continue — LLM classification is the primary path
    logger.warn('orchestrator', 'Qdrant indexing failed (non-blocking)', {
      error: err.message,
    });
  }
}

/**
 * Main pipeline orchestrator.
 *
 * Primary path: fetch → segment → LLM classify → store to Supabase
 * Secondary path (best-effort): embed → Qdrant upsert for retrieval
 *
 * On first run (no previous batch in Redis / degraded mode), fetches ALL
 * existing messages from community_messages_clean without a time window.
 * Subsequent runs use time-window-based incremental processing.
 */
async function runPipeline() {
  validateEnv();

  const batchId = randomUUID();
  logger.setBatchId(batchId);

  const startTime = Date.now();

  // Initialize Redis (fails gracefully into degraded mode)
  await batchTracker.initRedis();

  // Acquire distributed lock
  const locked = await batchTracker.acquireLock();
  if (!locked) {
    logger.warn('orchestrator', 'Pipeline lock already held — another instance is running. Exiting.');
    return;
  }

  // Record batch status
  const startedAt = new Date().toISOString();
  await batchTracker.setBatchStatus(batchId, 'running', startedAt);

  try {
    // Determine time window
    const lastBatch = await batchTracker.getLastBatch();
    const forceFull = process.env.FORCE_FULL_PIPELINE === 'true';

    let startTimeISO;
    let endTimeISO;

    if (forceFull) {
      logger.info('orchestrator', 'FORCE_FULL_PIPELINE is true — wiping Redis cursor and fetching ALL history');
      await batchTracker.setLastBatch('force-wipe', null); // Wipe tracker
      startTimeISO = null;
      endTimeISO = null;
    } else if (lastBatch && lastBatch.endTimestamp) {
      // Normal incremental run — process messages since last batch
      startTimeISO = lastBatch.endTimestamp;
      endTimeISO = new Date().toISOString();
      logger.info('orchestrator', 'Incremental run since last batch', {
        startTimeISO, endTimeISO,
      });
    } else {
      // FIRST RUN or degraded mode (no Redis) — process ALL existing data
      startTimeISO = null;
      endTimeISO = null;
      logger.info('orchestrator', 'First run — fetching ALL existing cleaned messages (no time filter)');
    }

    logger.info('orchestrator', 'Pipeline started', {
      timeWindow: { start: startTimeISO || 'ALL', end: endTimeISO || 'ALL' },
      degraded: batchTracker.isDegraded(),
    });

    // Step 1: Fetch messages
    const messages = await fetchMessages(startTimeISO, endTimeISO);

    if (messages.length === 0) {
      logger.info('orchestrator', 'No messages to process');
      // Only record endTimestamp if we had a real time window
      if (endTimeISO) {
        await batchTracker.setLastBatch(batchId, endTimeISO);
      }
      await batchTracker.setBatchStatus(batchId, 'done', startedAt, new Date().toISOString());
      return;
    }

    logger.info('orchestrator', `Processing ${messages.length} messages`);

    // Step 2: Group messages by calendar date (UTC)
    // Each date is processed independently for clean daily reporting
    const dailyGroups = groupMessagesByDate(messages);

    // Step 3: Process each date independently
    let totalSegments = 0;
    let totalClusters = 0;
    let totalMessageRows = 0;
    let allSegments = []; // Collect all segments for Qdrant indexing

    for (const [processingDate, dayMessages] of dailyGroups) {
      logger.info('orchestrator', `Processing date: ${processingDate}`, {
        messageCount: dayMessages.length,
      });

      // Run boundary detection for this date only
      const segments = await detectBoundariesPipeline(dayMessages);

      if (segments.length === 0) {
        logger.warn('orchestrator', `No segments for ${processingDate}`);
        continue;
      }

      allSegments = allSegments.concat(segments);

      // Build context blocks FIRST to get actual UUIDs for Supabase storage
      const contextBlocks = buildContextBlocks(segments);

      // LLM classification
      const classifications = await classifyPipeline(segments);

      // Store to Supabase with context block UUIDs
      const { clusterRows, messageRows } = await storeSegmentClassifications(
        classifications,
        segments,
        contextBlocks, // Pass context blocks for UUID mapping
        batchId,
        null, // Supabase client (uses default)
        processingDate
      );

      totalSegments += segments.length;
      totalClusters += clusterRows;
      totalMessageRows += messageRows;

      logger.info('orchestrator', `Completed ${processingDate}`, {
        segments: segments.length,
        clusters: clusterRows,
        messages: messageRows,
      });
    }

    // Step 4: Best-effort embed + Qdrant indexing (non-blocking)
    // Note: This runs on all segments together (not date-isolated)
    // Qdrant is used for RAG retrieval, not daily reporting
    await bestEffortEmbedAndIndex(allSegments);

    // Success — update tracking
    // Use the latest timestamp from the data we just processed
    const lastMsgTimestamp = messages[messages.length - 1]?.timestamp || new Date().toISOString();
    const durationMs = Date.now() - startTime;
    await batchTracker.setLastBatch(batchId, lastMsgTimestamp);
    await batchTracker.setBatchStatus(batchId, 'done', startedAt, new Date().toISOString());

    logger.info('orchestrator', 'Pipeline complete', {
      durationMs,
      messageCount: messages.length,
      datesProcessed: dailyGroups.size,
      totalSegments,
      totalClusters,
      totalMessageRows,
    });

  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error('orchestrator', 'Pipeline failed', {
      error: err.message,
      stack: err.stack?.slice(0, 1000),
      durationMs,
    });
    await batchTracker.setBatchStatus(batchId, 'failed', startedAt, new Date().toISOString());
    throw err;
  } finally {
    // ALWAYS release lock — even on crash
    await batchTracker.releaseLock();
    await batchTracker.close();
  }
}

// Run if executed directly
if (require.main === module) {
  runPipeline().catch((err) => {
    // Error already logged by orchestrator
    process.exitCode = 1;
  });
}

module.exports = { runPipeline };
