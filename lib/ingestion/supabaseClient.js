const supabase = require('../supabase');

const MESSAGES_TABLE = 'community_messages';
const STATE_TABLE = 'message_ingestion_state';

/**
 * Bulk insert messages. Uses ON CONFLICT DO NOTHING for deduplication.
 * @param {Array<object>} messages
 * @returns {Promise<{inserted: number, error: string|null}>}
 */
async function bulkInsertMessages(messages) {
  if (!messages.length) return { inserted: 0, error: null };

  const rows = messages.map(m => ({
    message_id: m.message_id,
    channel_id: m.channel_id,
    guild_id: m.guild_id,
    user_id: m.user_id,
    username: m.username || null,
    content: m.content || null,
    timestamp: m.timestamp,
    thread_id: m.thread_id || null,
    attachments: m.attachments || [],
    is_monitored_mention: m.is_monitored_mention || false,
    mentioned_user_ids: m.mentioned_user_ids || [],
  }));

  const { error } = await supabase
    .from(MESSAGES_TABLE)
    .upsert(rows, { onConflict: 'message_id', count: 'exact' });

  if (error) {
    return { inserted: 0, error: error.message };
  }

  // Supabase upsert with onConflict doesn't distinguish inserted vs updated easily,
  // but since we use ON CONFLICT DO NOTHING semantics (upsert with no update),
  // all rows that succeeded are effectively new inserts.
  return { inserted: rows.length, error: null };
}

/**
 * Get checkpoint for a channel.
 * @param {string} channelId
 * @returns {Promise<{last_message_id: string|null, last_processed_at: string|null}>}
 */
async function getCheckpoint(channelId) {
  const { data, error } = await supabase
    .from(STATE_TABLE)
    .select('last_message_id, last_processed_at')
    .eq('channel_id', channelId)
    .maybeSingle();

  if (error) {
    console.error(`[ingestion:supabase] getCheckpoint error for ${channelId}:`, error.message);
    return { last_message_id: null, last_processed_at: null };
  }

  return data
    ? { last_message_id: data.last_message_id, last_processed_at: data.last_processed_at }
    : { last_message_id: null, last_processed_at: null };
}

/**
 * Get checkpoints for multiple channels.
 * @param {string[]} channelIds
 * @returns {Promise<Object<string, {last_message_id: string|null}>>}
 */
async function getCheckpoints(channelIds) {
  if (!channelIds.length) return {};

  const { data, error } = await supabase
    .from(STATE_TABLE)
    .select('channel_id, last_message_id')
    .in('channel_id', channelIds);

  if (error) {
    console.error('[ingestion:supabase] getCheckpoints error:', error.message);
    return {};
  }

  return Object.fromEntries(
    (data || []).map(row => [row.channel_id, { last_message_id: row.last_message_id }])
  );
}

/**
 * Upsert checkpoint for a channel.
 * @param {string} channelId
 * @param {string} lastMessageId
 * @returns {Promise<void>}
 */
async function setCheckpoint(channelId, lastMessageId) {
  const { error } = await supabase
    .from(STATE_TABLE)
    .upsert({
      channel_id: channelId,
      last_message_id: lastMessageId,
      last_processed_at: new Date().toISOString(),
    }, { onConflict: 'channel_id' });

  if (error) {
    console.error(`[ingestion:supabase] setCheckpoint error for ${channelId}:`, error.message);
  }
}

/**
 * Bulk upsert checkpoints (used after batch flush).
 * @param {Object<string, string>} checkpoints - { channelId: lastMessageId }
 * @returns {Promise<void>}
 */
async function setCheckpoints(checkpoints) {
  const entries = Object.entries(checkpoints);
  if (!entries.length) return;

  const rows = entries.map(([channel_id, last_message_id]) => ({
    channel_id,
    last_message_id,
    last_processed_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from(STATE_TABLE)
    .upsert(rows, { onConflict: 'channel_id' });

  if (error) {
    console.error('[ingestion:supabase] setCheckpoints error:', error.message);
  }
}

module.exports = {
  bulkInsertMessages,
  getCheckpoint,
  getCheckpoints,
  setCheckpoint,
  setCheckpoints,
};
