// lib/mentionBriefing/contextCollector.js
// Fetches eligible monitored mentions and collects nearby context messages.

const supabase = require('../supabase');

const MENTIONS_TABLE = 'community_messages';

// ── Eligible mention scan ─────────────────────────────────────────────
// Rows where is_monitored_mention=true, mention_summary IS NULL,
// and created_at is at least 5 minutes old (restart-safe, no timers).

async function fetchEligibleMentions() {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from(MENTIONS_TABLE)
    .select('message_id, channel_id, thread_id, guild_id, user_id, username, content, timestamp, created_at, attachments, mentioned_user_ids')
    .eq('is_monitored_mention', true)
    .is('mention_summary', null)
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) throw error;
  return data || [];
}

// ── Context queries ───────────────────────────────────────────────────

/**
 * Previous N messages before the mention in the same channel/thread.
 * Returns in chronological order (oldest first).
 */
async function fetchPreviousMessages(mentionRow, limit = 5) {
  let query = supabase
    .from(MENTIONS_TABLE)
    .select('message_id, user_id, username, content, timestamp')
    .lt('timestamp', mentionRow.timestamp)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (mentionRow.thread_id) {
    query = query.eq('thread_id', mentionRow.thread_id);
  } else {
    query = query.eq('channel_id', mentionRow.channel_id).is('thread_id', null);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).reverse();
}

/**
 * Next N messages after the mention, only within the 5-minute window.
 */
async function fetchNextMessages(mentionRow, limit = 3) {
  const windowEnd = new Date(
    new Date(mentionRow.timestamp).getTime() + 5 * 60 * 1000
  ).toISOString();

  let query = supabase
    .from(MENTIONS_TABLE)
    .select('message_id, user_id, username, content, timestamp')
    .gt('timestamp', mentionRow.timestamp)
    .lte('timestamp', windowEnd)
    .order('timestamp', { ascending: true })
    .limit(limit);

  if (mentionRow.thread_id) {
    query = query.eq('thread_id', mentionRow.thread_id);
  } else {
    query = query.eq('channel_id', mentionRow.channel_id).is('thread_id', null);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Last N messages from the same author within 30 minutes before the mention.
 */
async function fetchAuthorRecentMessages(mentionRow, limit = 3) {
  const windowStart = new Date(
    new Date(mentionRow.timestamp).getTime() - 30 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from(MENTIONS_TABLE)
    .select('message_id, user_id, username, content, timestamp')
    .eq('user_id', mentionRow.user_id)
    .gte('timestamp', windowStart)
    .lte('timestamp', mentionRow.timestamp)
    .neq('message_id', mentionRow.message_id)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []).reverse();
}

/**
 * If the mention message is a reply, fetch the referenced parent message.
 * The reply info is stored in the attachments JSONB column.
 */
async function fetchReplyParent(mentionRow) {
  const replyInfo = mentionRow.attachments?.reply;
  if (!replyInfo?.message_id) return null;

  const { data, error } = await supabase
    .from(MENTIONS_TABLE)
    .select('message_id, user_id, username, content, timestamp')
    .eq('message_id', replyInfo.message_id)
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

// ── Full context assembly ─────────────────────────────────────────────

/**
 * Collect full context for a mention row.
 * Returns deduplicated array of context messages (chronological order).
 *
 * Rules:
 *  1. Always include the mention message itself
 *  2. Previous 5 messages in same channel/thread
 *  3. Next 3 messages within 5-minute window
 *  4. Last 3 messages from same author within 30 minutes
 *  5. If mention is a reply, include the referenced parent
 */
async function collectContext(mentionRow) {
  const [previous, next, authorRecent, replyParent] = await Promise.all([
    fetchPreviousMessages(mentionRow, 5),
    fetchNextMessages(mentionRow, 3),
    fetchAuthorRecentMessages(mentionRow, 3),
    fetchReplyParent(mentionRow),
  ]);

  // Mention message itself
  const mentionMessage = {
    message_id: mentionRow.message_id,
    user_id: mentionRow.user_id,
    username: mentionRow.username,
    content: mentionRow.content,
    timestamp: mentionRow.timestamp,
    is_mention: true,
  };

  // Deduplicate by message_id, preserve insertion order
  const seen = new Set();
  const candidates = [];

  function add(msg, source) {
    if (!msg || seen.has(msg.message_id)) return;
    seen.add(msg.message_id);
    candidates.push({ ...msg, source });
  }

  // Priority order: mention → reply parent → previous → next → author recent
  add(mentionMessage, 'mention');
  if (replyParent) add(replyParent, 'reply_parent');
  previous.forEach(m => add(m, 'previous'));
  next.forEach(m => add(m, 'next'));
  authorRecent.forEach(m => add(m, 'author_recent'));

  // Sort chronologically
  candidates.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return candidates;
}

// ── Write summary back ────────────────────────────────────────────────

/**
 * Write the generated summary to the mention row.
 * Only called after successful LLM generation.
 */
async function writeSummary(messageId, summary) {
  const { error } = await supabase
    .from(MENTIONS_TABLE)
    .update({
      mention_summary: summary,
      mention_summary_generated_at: new Date().toISOString(),
    })
    .eq('message_id', messageId);

  if (error) throw error;
}

module.exports = {
  fetchEligibleMentions,
  collectContext,
  writeSummary,
};
