// lib/speaker.js — Derived speaker role detection
// No database writes. Pure functions over Discord state.

/**
 * Collect all support role IDs from environment variables.
 * Used for staff detection across departments.
 */
function getAllSupportRoleIds() {
  return [
    process.env.ROLE_BILLING,
    process.env.ROLE_TECHNICAL,
    process.env.ROLE_PRODUCT,
    process.env.ROLE_UNCLASSIFIED
  ].filter(Boolean);
}

/**
 * Check if a guild member has any support role.
 * @param {import('discord.js').GuildMember|null} member
 * @returns {boolean}
 */
function isStaff(member) {
  if (!member || !member.roles) return false;
  const supportRoleIds = getAllSupportRoleIds();
  return supportRoleIds.some(id => member.roles.cache.has(id));
}

/**
 * Determine the speaker role for a message author.
 * @param {string} authorId — Discord user ID of the message author
 * @param {string} reporterId — Discord user ID of the issue reporter
 * @param {boolean} isStaffFlag — Whether the author has a support role
 * @returns {'reporter'|'participant'|'staff'|'bot'}
 */
function getSpeakerRole(authorId, reporterId, isStaffFlag) {
  if (isStaffFlag) return 'staff';
  if (authorId === reporterId) return 'reporter';
  return 'participant';
}

/**
 * Check if the last 3+ messages in a thread are all from non-reporter, non-bot users.
 * Indicates participants are discussing among themselves — bot should not interrupt.
 * @param {import('discord.js').ThreadChannel} thread
 * @param {string} reporterId
 * @param {string} botId
 * @returns {Promise<boolean>}
 */
async function isParticipantDiscussion(thread, reporterId, botId) {
  let recentMessages;
  try {
    recentMessages = await thread.messages.fetch({ limit: 4 });
  } catch (err) {
    console.warn('[speaker] Could not fetch recent messages for discussion check:', err.message);
    return false;
  }

  const last3 = Array.from(recentMessages.values())
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .slice(-3);

  if (last3.length < 3) return false;

  return last3.every(m =>
    m.author.id !== reporterId &&
    m.author.id !== botId
  );
}

module.exports = { getAllSupportRoleIds, isStaff, getSpeakerRole, isParticipantDiscussion };
