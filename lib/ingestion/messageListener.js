const { pushAndMaybeFlush } = require('./batchWriter');
const { structureMessage, MIN_MESSAGE_DATE } = require('./ingestionCheckpoint');

/** @type {Set<string>} */
let watchedChannels = new Set();

/**
 * Set the channels to watch for message ingestion.
 * @param {string[]} channelIds
 */
function setChannels(channelIds) {
  watchedChannels = new Set(channelIds);
}

/**
 * Get the current set of watched channels.
 * @returns {Set<string>}
 */
function getChannels() {
  return watchedChannels;
}

/**
 * Resolve the effective channel ID for a message.
 * For thread messages, returns the parent channel ID.
 * For regular messages, returns the channel ID directly.
 * @param {import('discord.js').Message} message
 * @returns {string|null}
 */
function resolveParentChannelId(message) {
  if (message.channel.isThread()) {
    return message.channel.parentId || null;
  }
  return message.channelId;
}

/**
 * Handle a Discord messageCreate event.
 * Filters by watched channels (including threads inside them),
 * bot/system messages, then enqueues for batch writing.
 *
 * This function MUST NOT throw — it's called from the main event loop.
 * @param {import('discord.js').Message} message
 */
function handleMessage(message) {
  try {
    // Ignore bot messages
    if (message.author.bot) return;

    // Ignore system/pin/join messages
    if (message.system) return;

    // Resolve parent channel — threads inherit from their parent channel
    const parentChannelId = resolveParentChannelId(message);

    // Only capture from configured channels (or threads inside them)
    if (!parentChannelId || !watchedChannels.has(parentChannelId)) return;

    // Ignore messages older than the minimum date boundary
    if (MIN_MESSAGE_DATE && message.createdTimestamp < MIN_MESSAGE_DATE) return;

    // Ignore empty content (no text and no attachments)
    const hasContent = message.content && message.content.trim().length > 0;
    const hasAttachments = message.attachments && message.attachments.size > 0;
    if (!hasContent && !hasAttachments) return;

    const structured = structureMessage(message);
    pushAndMaybeFlush(structured);
  } catch (err) {
    // Never let ingestion errors bubble up to the main bot loop
    console.error('[ingestion:listener] Error processing message:', err.message);
  }
}

module.exports = { handleMessage, setChannels, getChannels };
