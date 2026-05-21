const { getCheckpoints } = require('./supabaseClient');

// Minimum message timestamp — messages older than this are never ingested
const MIN_MESSAGE_DATE = process.env.MIN_MESSAGE_DATE
  ? new Date(process.env.MIN_MESSAGE_DATE).getTime()
  : 0; // 0 = no filter if env var not set

/**
 * Backfill window: how many seconds to look back after last checkpoint on restart.
 * 5 minutes covers brief restarts without fetching full history.
 */
const BACKFILL_WINDOW_SECONDS = 300;

// Monitored user IDs from env — ambassadors, officials, admins, support
const MONITORED_IDS = new Set(
  (process.env.MONITORED_USER_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

const MENTION_REGEX = /<@!?(\d+)>/g;

/**
 * Detect monitored mentions in message content.
 * Compares mentioned user IDs against MONITORED_USER_IDS env var.
 * @param {string} content - raw message content
 * @returns {{ is_monitored_mention: boolean, mentioned_user_ids: string[] }}
 */
function detectMonitoredMentions(content) {
  if (!content || MONITORED_IDS.size === 0) {
    return { is_monitored_mention: false, mentioned_user_ids: [] };
  }

  const matchedIds = [];
  let match;
  const regex = new RegExp(MENTION_REGEX.source, 'g');

  while ((match = regex.exec(content)) !== null) {
    const userId = match[1];
    if (MONITORED_IDS.has(userId)) {
      matchedIds.push(userId);
    }
  }

  return {
    is_monitored_mention: matchedIds.length > 0,
    mentioned_user_ids: matchedIds,
  };
}

/**
 * Fetch messages after the last known checkpoint for each configured channel.
 * Uses Discord's before/after cursor pagination — no full history scan.
 *
 * @param {import('discord.js').Client} client
 * @param {string[]} channelIds
 * @returns {Promise<Array<object>>} array of structured messages ready for queue
 */
async function backfill(client, channelIds) {
  if (!channelIds.length) return [];

  const checkpoints = await getCheckpoints(channelIds);
  const allMessages = [];

  for (const channelId of channelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.messages) continue;

      const lastId = checkpoints[channelId]?.last_message_id || null;

      const options = { limit: 100 };
      if (lastId) {
        options.after = lastId;
      }

      const messages = await channel.messages.fetch(options);

      for (const [id, msg] of messages) {
        if (id === lastId) continue;
        // Skip messages older than the minimum date boundary
        if (msg.createdTimestamp < MIN_MESSAGE_DATE) continue;
        allMessages.push(structureMessage(msg));
      }

      if (allMessages.length) {
        console.log(
          `[ingestion:checkpoint] Backfilled ${allMessages.length} messages for ${channelId}`
        );
      }
    } catch (err) {
      console.error(
        `[ingestion:checkpoint] Backfill failed for ${channelId}: ${err.message}`
      );
    }
  }

  return allMessages;
}

/**
 * Convert a Discord Message to the structured ingestion format.
 * For thread messages: channel_id = parent channel, thread_id = the thread itself.
 * For regular messages: channel_id = the channel, thread_id = null.
 *
 * Reply references are stored inside the attachments JSONB:
 *   { attachments: [...], reply: { message_id, channel_id, guild_id } }
 *
 * Monitored mentions are detected and stored as:
 *   is_monitored_mention: boolean
 *   mentioned_user_ids: string[]
 *
 * @param {import('discord.js').Message} message
 * @returns {object}
 */
function structureMessage(message) {
  const isThread = message.channel.isThread();
  const channelId = isThread ? message.channel.parentId : message.channelId;
  const threadId = isThread ? message.channelId : null;

  // Build attachments array
  const attachmentArray = message.attachments
    ? Array.from(message.attachments.values()).map(a => ({
        id: a.id,
        filename: a.filename,
        url: a.url,
        size: a.size,
        contentType: a.contentType,
      }))
    : [];

  // Build metadata object — attachments JSONB stores both files and reply reference
  const metadata = {
    attachments: attachmentArray,
  };

  // Extract reply reference if this message is a reply
  if (message.reference) {
    metadata.reply = {
      message_id: message.reference.messageId || null,
      channel_id: message.reference.channelId || null,
      guild_id: message.reference.guildId || null,
    };
  }

  // Detect monitored mentions (ambassadors, officials, admins, support)
  const { is_monitored_mention, mentioned_user_ids } = detectMonitoredMentions(message.content);

  return {
    message_id: message.id,
    channel_id: channelId,
    guild_id: message.guildId,
    user_id: message.author.id,
    username: message.author.username,
    content: message.content || null,
    timestamp: message.createdAt.toISOString(),
    thread_id: threadId,
    attachments: metadata,
    is_monitored_mention,
    mentioned_user_ids,
  };
}

module.exports = { backfill, structureMessage, BACKFILL_WINDOW_SECONDS, detectMonitoredMentions, MIN_MESSAGE_DATE };
