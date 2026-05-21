const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const { generateTopicSummaries } = require('./topicSummarizer');

// Lazy-initialized Supabase client (avoids crash when env vars missing at require time)
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
  }
  return _supabase;
}


/**
 * Store LLM-based segment classifications to Supabase.
 * Groups segments by topic label and writes to pipeline_clusters + pipeline_cluster_messages.
 * Also generates LLM summaries for each topic.
 *
 * CRITICAL: This function enforces date isolation. Before inserting clusters for a
 * processing date, it DELETEs any existing clusters for that date. This makes the
 * pipeline idempotent — re-running for a specific date will regenerate only that
 * date's data without affecting other dates.
 *
 * @param {Map<number, string>} classifications - segmentIndex → topicLabel
 * @param {Array<{segmentIndex: number, messages: Array, boundaryScore: number|null, startTimestamp: string, endTimestamp: string}>} segments
 * @param {Array<{contextBlockId: string, segmentIndex: number, messageIds: string[]}>} contextBlocks - Context blocks with real UUIDs
 * @param {string} batchId
 * @param {object} [client] - Optional Supabase client override (for testing)
 * @param {string} processingDate - Calendar date (YYYY-MM-DD) for date isolation
 * @returns {Promise<{clusterRows: number, messageRows: number, summaryRows: number}>}
 */
async function storeSegmentClassifications(classifications, segments, contextBlocks, batchId, client, processingDate) {
  const db = client || getSupabase();

  // Validate processingDate
  if (!processingDate) {
    throw new Error('processingDate is required for date isolation. See pipeline/README.md for migration.');
  }

  // DATE ISOLATION: Delete existing clusters for this processing date
  // This ensures idempotent re-processing — running the pipeline for a specific
  // date will completely replace that date's data without duplicates
  logger.info('storeResults', `Deleting existing clusters for ${processingDate} (date isolation)`);

  const { error: deleteClusterError } = await db
    .from('pipeline_clusters')
    .delete()
    .eq('processing_date', processingDate);

  if (deleteClusterError) {
    throw new Error(`Failed to delete existing clusters for ${processingDate}: ${deleteClusterError.message}`);
  }

  const { error: deleteSummaryError } = await db
    .from('pipeline_topic_summaries')
    .delete()
    .eq('processing_date', processingDate);

  if (deleteSummaryError) {
    throw new Error(`Failed to delete existing summaries for ${processingDate}: ${deleteSummaryError.message}`);
  }

  const { error: deleteMsgError } = await db
    .from('pipeline_cluster_messages')
    .delete()
    .eq('processing_date', processingDate);

  if (deleteMsgError) {
    throw new Error(`Failed to delete existing cluster messages for ${processingDate}: ${deleteMsgError.message}`);
  }

  logger.info('storeResults', `Cleared existing data for ${processingDate}`);

  // Build message → contextBlockId mapping from actual context blocks
  // Each message can appear in multiple context blocks (sliding window), so we map to an array
  const messageToContextBlock = new Map();
  for (const block of contextBlocks) {
    for (const msgId of block.messageIds) {
      if (!messageToContextBlock.has(msgId)) {
        messageToContextBlock.set(msgId, []);
      }
      // Store the context block UUID - use the block where this message is the anchor (last position)
      if (block.messageIds[block.messageIds.length - 1] === msgId) {
        messageToContextBlock.get(msgId).push(block.contextBlockId);
      }
    }
  }

  // Group segments by topic label
  const labelGroups = new Map();
  for (const segment of segments) {
    const label = classifications.get(segment.segmentIndex) || 'uncategorized';
    if (!labelGroups.has(label)) {
      labelGroups.set(label, []);
    }
    labelGroups.get(label).push(segment);
  }

  if (labelGroups.size === 0) {
    logger.warn('storeResults', 'No classifications to write');
    return { clusterRows: 0, messageRows: 0, summaryRows: 0 };
  }

  const clusterRows = [];
  const messageRows = [];
  let clusterIdCounter = 0;

  for (const [topicLabel, groupSegments] of labelGroups) {
    const clusterId = clusterIdCounter++;

    // Aggregate stats across all segments in this label group
    const uniqueMessageIds = new Set();
    const uniqueUserIds = new Set();
    const boundaryScores = [];
    let minTimestamp = groupSegments[0].startTimestamp;
    let maxTimestamp = groupSegments[0].endTimestamp;

    for (const seg of groupSegments) {
      if (seg.startTimestamp < minTimestamp) minTimestamp = seg.startTimestamp;
      if (seg.endTimestamp > maxTimestamp) maxTimestamp = seg.endTimestamp;
      if (seg.boundaryScore !== null && seg.boundaryScore !== undefined) {
        boundaryScores.push(seg.boundaryScore);
      }
      for (const msg of seg.messages) {
        uniqueMessageIds.add(msg.message_id);
        if (msg.user_id) uniqueUserIds.add(msg.user_id);
      }
    }

    const avgBoundaryScore = boundaryScores.length > 0
      ? boundaryScores.reduce((a, b) => a + b, 0) / boundaryScores.length
      : null;

    clusterRows.push({
      batch_id: batchId,
      cluster_id: clusterId,
      topic_label: topicLabel,
      start_timestamp: minTimestamp,
      end_timestamp: maxTimestamp,
      message_count: uniqueMessageIds.size,
      unique_users: uniqueUserIds.size,
      avg_boundary_score: avgBoundaryScore,
      processing_date: processingDate, // DATE ISOLATION: Explicit date column
    });

    // Build message join rows with REAL context block UUIDs
    for (const seg of groupSegments) {
      for (const msg of seg.messages) {
        // Get the context block UUID(s) for this message
        const contextBlockIds = messageToContextBlock.get(msg.message_id) || [];
        // Use the first (primary) context block UUID - this is where the message is the anchor
        const contextBlockId = contextBlockIds.length > 0 ? contextBlockIds[0] : null;

        messageRows.push({
          batch_id: batchId,
          cluster_id: clusterId,
          message_id: msg.message_id,
          context_block_id: contextBlockId, // REAL UUID from contextBuilder.js
          channel_id: msg.channel_id || null,
          user_id: msg.user_id || null,
          processing_date: processingDate, // DATE ISOLATION: Explicit date column
        });
      }
    }
  }

  // Write cluster rows
  const { error: clusterError } = await db
    .from('pipeline_clusters')
    .insert(clusterRows);

  if (clusterError) {
    throw new Error(`Failed to insert pipeline_clusters: ${clusterError.message}`);
  }

  // Write message join rows in chunks
  const msgChunkSize = 500;
  let msgInserted = 0;

  for (let i = 0; i < messageRows.length; i += msgChunkSize) {
    const chunk = messageRows.slice(i, i + msgChunkSize);
    const { error: msgError } = await db
      .from('pipeline_cluster_messages')
      .insert(chunk);

    if (msgError) {
      throw new Error(`Failed to insert pipeline_cluster_messages: ${msgError.message}`);
    }
    msgInserted += chunk.length;
  }

  // Generate LLM summaries for each topic
  logger.info('storeResults', 'Generating LLM topic summaries...', { processingDate });
  const topicSummaries = await generateTopicSummaries(
    classifications,
    segments,
    batchId,
    processingDate // Pass processingDate for date isolation
  );
  
  // Write summaries to database
  if (topicSummaries.length > 0) {
    const { error: summaryError } = await db
      .from('pipeline_topic_summaries')
      .insert(topicSummaries);
    
    if (summaryError) {
      logger.error('storeResults', 'Failed to insert topic summaries', { error: summaryError.message });
      // Don't throw - summaries are nice-to-have, not critical
    } else {
      logger.info('storeResults', `Inserted ${topicSummaries.length} topic summaries`);
    }
  }

  logger.info('storeResults', 'Segment classifications written to Supabase', {
    clusterRows: clusterRows.length,
    messageRows: msgInserted,
    summaryRows: topicSummaries.length,
    topicLabels: Array.from(labelGroups.keys()),
  });

  return { 
    clusterRows: clusterRows.length, 
    messageRows: msgInserted,
    summaryRows: topicSummaries.length,
  };
}

module.exports = { storeSegmentClassifications };
