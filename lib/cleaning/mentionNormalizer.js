// lib/cleaning/mentionNormalizer.js
// Replaces Discord mention IDs (<@123456>) with readable usernames (<mentioned_name>)
// during the cleaning pipeline. Only modifies community_messages_clean.content.

const supabase = require('../supabase');

const MENTION_REGEX = /<@!?(\d+)>/g;

/**
 * Collect all unique mentioned user IDs from a batch of messages.
 * @param {Array<string>} contents - array of message content strings
 * @returns {Set<string>} unique user IDs found in mentions
 */
function collectMentionedUserIds(contents) {
  const ids = new Set();
  for (const content of contents) {
    if (!content) continue;
    let match;
    const regex = new RegExp(MENTION_REGEX.source, 'g');
    while ((match = regex.exec(content)) !== null) {
      ids.add(match[1]);
    }
  }
  return ids;
}

/**
 * Look up usernames for a set of user IDs from community_messages.
 * Returns a Map of user_id → username.
 * @param {Set<string>} userIds
 * @returns {Promise<Map<string, string>>}
 */
async function lookupUsernames(userIds) {
  if (userIds.size === 0) return new Map();

  const idArray = Array.from(userIds);

  // Query community_messages for distinct user_id → username mappings
  // We only need the raw table — it has every user who ever sent a message
  const { data, error } = await supabase
    .from('community_messages')
    .select('user_id, username')
    .in('user_id', idArray);

  if (error) {
    console.error('[mentionNormalizer] Username lookup failed:', error.message);
    return new Map();
  }

  const map = new Map();
  for (const row of (data || [])) {
    // Only set if we have a valid username (first one wins for dedup)
    if (row.username && !map.has(row.user_id)) {
      map.set(row.user_id, row.username);
    }
  }

  return map;
}

/**
 * Replace all Discord mentions in a content string with <mentioned_username>.
 * Falls back to original mention if username not found.
 * @param {string} content - message content
 * @param {Map<string, string>} usernameMap - user_id → username lookup
 * @returns {string}
 */
function replaceMentions(content, usernameMap) {
  if (!content) return content;

  return content.replace(MENTION_REGEX, (match, userId) => {
    const username = usernameMap.get(userId);
    if (!username) return match;
    return `<mentioned_${username}>`;
  });
}

/**
 * Normalize all mentions in a batch of messages.
 * Collects all mentioned user IDs, does a single bulk lookup,
 * then replaces mentions in all messages.
 *
 * @param {Array<{content: string|null}>} messages - array of message objects with content field
 * @returns {Promise<Array<string|null>>} array of content strings with mentions replaced
 */
async function normalizeMentionsBatch(messages) {
  const contents = messages.map(m => m.content);
  const mentionedIds = collectMentionedUserIds(contents);

  if (mentionedIds.size === 0) {
    return contents;
  }

  const usernameMap = await lookupUsernames(mentionedIds);

  if (usernameMap.size === 0) {
    return contents;
  }

  return contents.map(content => replaceMentions(content, usernameMap));
}

module.exports = { collectMentionedUserIds, lookupUsernames, replaceMentions, normalizeMentionsBatch };
