/**
 * Recovery script: re-generates failed topic summaries for a specific processing date.
 *
 * Usage:
 *   node pipeline/src/recoverSummaries.js 2025-05-25
 *   node pipeline/src/recoverSummaries.js 2025-05-25 --dry-run
 *
 * A summary is considered "failed" if llm_tokens_used = 0 (meaning the LLM never
 * produced a usable response and the pipeline fell back to a generic placeholder).
 *
 * The script:
 *   1. Reads pipeline_clusters for the date (left unchanged)
 *   2. Reads pipeline_topic_summaries to find rows with llm_tokens_used = 0
 *   3. For each failed summary, fetches the original messages from
 *      pipeline_cluster_messages + community_messages_clean
 *   4. Rebuilds a minimal segment structure and calls summarizeTopic()
 *   5. Updates only the failed summary rows in pipeline_topic_summaries
 *
 * Clusters and message assignments are never touched.
 */

const { createClient } = require('@supabase/supabase-js');
try { require('dotenv').config(); } catch { }

const logger = require('./logger');
const { summarizeTopic } = require('./topicSummarizer');
const { PIPELINE_CONFIG } = require('../pipeline.config');

const args = process.argv.slice(2);
const processingDate = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!processingDate || !/^\d{4}-\d{2}-\d{2}$/.test(processingDate)) {
  console.error('Usage: node pipeline/src/recoverSummaries.js <YYYY-MM-DD> [--dry-run]');
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const CHAT_MODEL = PIPELINE_CONFIG.CHAT_MODEL;

async function recoverSummaries() {
  logger.setBatchId('recover-' + processingDate);
  logger.info('recoverSummaries', `Starting recovery for ${processingDate}`, { dryRun });

  // 1. Load clusters for this date
  const { data: clusters, error: clusterError } = await supabase
    .from('pipeline_clusters')
    .select('cluster_id, topic_label, start_timestamp, end_timestamp, message_count, unique_users')
    .eq('processing_date', processingDate);

  if (clusterError) throw new Error(`Failed to load clusters: ${clusterError.message}`);
  if (!clusters || clusters.length === 0) {
    logger.info('recoverSummaries', `No clusters found for ${processingDate}`);
    return;
  }

  logger.info('recoverSummaries', `Found ${clusters.length} clusters for ${processingDate}`);

  // 2. Load existing summaries — find the failed ones
  const { data: summaries, error: summaryError } = await supabase
    .from('pipeline_topic_summaries')
    .select('id, cluster_id, topic_label, summary, llm_tokens_used')
    .eq('processing_date', processingDate);

  if (summaryError) throw new Error(`Failed to load summaries: ${summaryError.message}`);

  // Identify failed summaries: llm_tokens_used = 0 means fallback was used
  const failedSummaries = (summaries || []).filter(s => s.llm_tokens_used === 0);
  const succeededCount = (summaries || []).length - failedSummaries.length;

  logger.info('recoverSummaries', `Summary status for ${processingDate}`, {
    total: summaries?.length || 0,
    succeeded: succeededCount,
    failed: failedSummaries.length,
    failedTopics: failedSummaries.map(s => s.topic_label),
  });

  if (failedSummaries.length === 0) {
    logger.info('recoverSummaries', 'No failed summaries to recover');
    return;
  }

  if (dryRun) {
    logger.info('recoverSummaries', 'Dry run — would recover these topics:', {
      topics: failedSummaries.map(s => ({ topic_label: s.topic_label, cluster_id: s.cluster_id })),
    });
    return;
  }

  // 3. For each failed summary, recover it
  let recovered = 0;
  let stillFailed = 0;

  for (const failedSummary of failedSummaries) {
    const { cluster_id, topic_label } = failedSummary;
    const cluster = clusters.find(c => c.cluster_id === cluster_id);

    if (!cluster) {
      logger.warn('recoverSummaries', `No cluster found for cluster_id=${cluster_id}, skipping`);
      stillFailed++;
      continue;
    }

    logger.info('recoverSummaries', `Recovering "${topic_label}" (cluster_id=${cluster_id})`);

    try {
      // Get message IDs for this cluster
      const { data: clusterMessages, error: cmError } = await supabase
        .from('pipeline_cluster_messages')
        .select('message_id')
        .eq('processing_date', processingDate)
        .eq('cluster_id', cluster_id);

      if (cmError) throw new Error(`Failed to load cluster messages: ${cmError.message}`);

      const messageIds = (clusterMessages || []).map(m => m.message_id);

      if (messageIds.length === 0) {
        logger.warn('recoverSummaries', `No messages for cluster_id=${cluster_id}, skipping`);
        stillFailed++;
        continue;
      }

      // Fetch actual message content
      const { data: messages, error: msgError } = await supabase
        .from('community_messages_clean')
        .select('message_id, content, username, user_id, timestamp, channel_id')
        .in('message_id', messageIds);

      if (msgError) throw new Error(`Failed to load messages: ${msgError.message}`);

      if (!messages || messages.length === 0) {
        logger.warn('recoverSummaries', `No message content found for cluster_id=${cluster_id}, skipping`);
        stillFailed++;
        continue;
      }

      // Sort messages by timestamp
      messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // Build a minimal segment structure for summarizeTopic()
      const segment = {
        segmentIndex: 0,
        startTimestamp: cluster.start_timestamp,
        endTimestamp: cluster.end_timestamp,
        messages: messages.map(m => ({
          message_id: m.message_id,
          content: m.content,
          username: m.username,
          user_id: m.user_id,
          timestamp: m.timestamp,
          channel_id: m.channel_id,
        })),
      };

      // Generate new summary with the fixed parser
      const llmSummary = await summarizeTopic(topic_label, [segment]);

      if (llmSummary.error) {
        logger.warn('recoverSummaries', `Summary still failed for "${topic_label}": ${llmSummary.error}`);
        stillFailed++;
        continue;
      }

      // Update the summary row
      const { error: updateError } = await supabase
        .from('pipeline_topic_summaries')
        .update({
          summary: llmSummary.summary,
          key_issues: llmSummary.key_issues,
          unanswered_questions: llmSummary.unanswered_questions,
          sentiment: llmSummary.sentiment,
          severity: llmSummary.severity,
          llm_tokens_used: llmSummary.tokensUsed,
        })
        .eq('id', failedSummary.id);

      if (updateError) {
        logger.error('recoverSummaries', `Failed to update summary for "${topic_label}"`, { error: updateError.message });
        stillFailed++;
        continue;
      }

      recovered++;
      logger.info('recoverSummaries', `Recovered "${topic_label}"`, {
        sentiment: llmSummary.sentiment,
        severity: llmSummary.severity,
        tokensUsed: llmSummary.tokensUsed,
      });

      // Small delay between recoveries to avoid rate limits
      await new Promise(r => setTimeout(r, 300));

    } catch (err) {
      logger.error('recoverSummaries', `Error recovering "${topic_label}"`, { error: err.message });
      stillFailed++;
    }
  }

  logger.info('recoverSummaries', `Recovery complete for ${processingDate}`, {
    recovered,
    stillFailed,
    totalFailed: failedSummaries.length,
  });
}

recoverSummaries()
  .then(() => {
    logger.info('recoverSummaries', 'Done');
    process.exit(0);
  })
  .catch(err => {
    logger.error('recoverSummaries', 'Fatal error', { error: err.message, stack: err.stack });
    process.exit(1);
  });
