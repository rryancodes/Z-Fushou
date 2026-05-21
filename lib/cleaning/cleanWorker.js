const supabase = require('../supabase');
const { isNoise } = require('./noiseFilters');
const { normalize } = require('./normalizeText');
const { normalizeMentionsBatch } = require('./mentionNormalizer');

const RAW_TABLE = 'community_messages';
const CLEAN_TABLE = 'community_messages_clean';
const BATCH_SIZE = 500;

/**
 * Fetch a batch of uncleaned messages from the raw ingestion table.
 * Uses the is_cleaned flag — only fetches rows where is_cleaned = FALSE.
 * Ordered by created_at for deterministic processing.
 * @returns {Promise<Array<object>>}
 */
async function fetchUncleanedBatch() {
  const { data, error } = await supabase
    .from(RAW_TABLE)
    .select('message_id, channel_id, user_id, username, content, timestamp')
    .eq('is_cleaned', false)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    throw new Error(`Failed to fetch uncleaned batch: ${error.message}`);
  }

  return data || [];
}

/**
 * Mark a single raw message as cleaned, linking it to its clean row.
 * Uses message_id (text) as the primary key for community_messages.
 * @param {string} messageId - The message_id (text PK) of the raw message
 * @param {number|null} cleanRowId - The id from community_messages_clean, or null if noise
 */
async function markCleaned(messageId, cleanRowId) {
  const update = {
    is_cleaned: true,
    cleaned_message_id: cleanRowId,
  };

  const { error } = await supabase
    .from(RAW_TABLE)
    .update(update)
    .eq('message_id', messageId);

  if (error) {
    throw new Error(`Failed to mark message ${messageId} as cleaned: ${error.message}`);
  }
}

/**
 * Process a single batch: filter noise, normalize mentions, normalize text,
 * insert clean rows, then update original rows with is_cleaned + cleaned_message_id.
 *
 * Order:
 *   1. Filter noise
 *   2. Normalize mentions (<@id> → <mentioned_username>)
 *   3. Normalize text (strip markdown, lowercase, collapse whitespace)
 *   4. Insert into community_messages_clean
 *   5. Update community_messages with is_cleaned=TRUE + cleaned_message_id
 *
 * Noise messages are marked is_cleaned=TRUE with cleaned_message_id=NULL.
 *
 * @returns {Promise<{fetched: number, cleaned: number, noise: number, errors: number}>}
 */
async function processBatch() {
  const rawMessages = await fetchUncleanedBatch();

  if (!rawMessages.length) {
    return { fetched: 0, cleaned: 0, noise: 0, errors: 0 };
  }

  // Phase 1: Filter noise
  const validMessages = [];
  const seenMessages = [];
  let noiseCount = 0;

  for (const msg of rawMessages) {
    const { isNoise: noise } = isNoise(msg, seenMessages);

    if (noise) {
      try {
        await markCleaned(msg.message_id, null);
      } catch (err) {
        console.error(`[cleaning] Failed to mark noise ${msg.message_id}: ${err.message}`);
      }
      noiseCount++;
      continue;
    }

    // Track for duplicate detection in subsequent messages
    seenMessages.push({
      user_id: msg.user_id,
      content: msg.content,
      timestamp: msg.timestamp,
    });

    validMessages.push(msg);
  }

  if (validMessages.length === 0) {
    return { fetched: rawMessages.length, cleaned: 0, noise: noiseCount, errors: 0 };
  }

  // Phase 2: Normalize mentions (batch — single DB lookup for all mentioned users)
  let mentionNormalizedContents;
  try {
    mentionNormalizedContents = await normalizeMentionsBatch(validMessages);
  } catch (err) {
    console.error('[cleaning] Mention normalization failed, using raw content:', err.message);
    mentionNormalizedContents = validMessages.map(m => m.content);
  }

  // Phase 3: Normalize text + build clean rows
  const cleanRows = [];

  for (let i = 0; i < validMessages.length; i++) {
    const msg = validMessages[i];
    const afterMentions = mentionNormalizedContents[i];

    // Run text normalization on mention-replaced content
    const normalizedContent = normalize(afterMentions);

    // If normalization wiped the content entirely, treat as noise
    if (!normalizedContent) {
      try {
        await markCleaned(msg.message_id, null);
      } catch (err) {
        console.error(`[cleaning] Failed to mark empty-normalized ${msg.message_id}: ${err.message}`);
      }
      noiseCount++;
      continue;
    }

    cleanRows.push({
      message_id: msg.message_id,
      channel_id: msg.channel_id,
      user_id: msg.user_id,
      username: msg.username,
      content: normalizedContent,
      timestamp: msg.timestamp,
    });
  }

  // Phase 4: Bulk insert cleaned messages
  let insertedRows = [];
  if (cleanRows.length > 0) {
    const { data, error } = await supabase
      .from(CLEAN_TABLE)
      .upsert(cleanRows, { onConflict: 'message_id' })
      .select('id, message_id');

    if (error) {
      throw new Error(`Failed to insert clean batch: ${error.message}`);
    }

    insertedRows = data || [];
  }

  // Build message_id → inserted clean row id lookup
  const insertedByMessageId = new Map();
  for (const row of insertedRows) {
    insertedByMessageId.set(row.message_id, row.id);
  }

  // Phase 5: Update each original raw message with is_cleaned=TRUE + cleaned_message_id
  let errorCount = 0;
  for (const cleanRow of cleanRows) {
    const cleanRowId = insertedByMessageId.get(cleanRow.message_id) || null;

    try {
      await markCleaned(cleanRow.message_id, cleanRowId);
    } catch (err) {
      console.error(`[cleaning] Failed to update raw ${cleanRow.message_id}: ${err.message}`);
      errorCount++;
    }
  }

  return {
    fetched: rawMessages.length,
    cleaned: cleanRows.length,
    noise: noiseCount,
    errors: errorCount,
  };
}

/**
 * Run one cleaning cycle. Wraps in try/catch to never crash the worker.
 * @returns {Promise<{fetched: number, cleaned: number, noise: number, errors: number}|null>}
 */
async function runCycle() {
  try {
    console.log('[cleaning] Clean batch started');
    const stats = await processBatch();
    console.log(
      `[cleaning] Fetched: ${stats.fetched} | Cleaned: ${stats.cleaned} | Noise: ${stats.noise} | Errors: ${stats.errors}`
    );
    return stats;
  } catch (err) {
    console.error(`[cleaning] Batch failed: ${err.message}`);
    return null;
  }
}

module.exports = { fetchUncleanedBatch, processBatch, runCycle };
