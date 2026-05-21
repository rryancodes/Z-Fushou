const { ChannelType } = require('discord.js');
const config = require('./config');

async function createReportThread(client, issue, user) {
  const channelId = await config.get(
    'report_channel_id',
    process.env.BAD_REPORT_CHANNEL_ID
  );

  if (!channelId) {
    console.warn('No report channel configured');
    return null;
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    console.error('Could not fetch report channel:', err.message);
    return null;
  }

  const lines = [
    `**Issue ID:** ${issue.short_id}`,
    `**Reported by:** <@${user.id}>`,
    `**Department:** ${issue.department}`,
    ``,
    `**Summary**`,
    issue.title,
    ``,
    `**Details**`,
    issue.description,
  ];

  if (issue.steps_tried) {
    lines.push(``, `**Steps already tried**`, issue.steps_tried);
  }

  lines.push(``, `*Status updates will appear here as this issue progresses.*`);

  const content = lines.join('\n');

  // Forum channel
  if (channel.type === ChannelType.GuildForum) {
    try {
      // The first message is passed inside threads.create itself
      // This is the ONLY reliable way to post the opening message in a forum thread
      const thread = await channel.threads.create({
        name:    `${issue.short_id} — ${issue.title}`.slice(0, 100),
        message: { content },
        reason:  `Issue ${issue.short_id} by ${user.username}`
      });

      return thread;
    } catch (err) {
      console.error('Forum post creation failed:', err.message);
      return null;
    }
  }

  // Regular text channel fallback
  if (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  ) {
    try {
      const msg = await channel.send({ content });
      const thread = await msg.startThread({
        name:   `${issue.short_id} — ${issue.title}`.slice(0, 100),
        reason: `Issue ${issue.short_id} by ${user.username}`
      });
      return thread;
    } catch (err) {
      console.error('Text thread creation failed:', err.message);
      return null;
    }
  }

  console.error(`Unsupported channel type: ${channel.type}`);
  return null;
}

async function postStatusUpdate(client, threadId, shortId, newStatus, note) {
  try {
    const thread = await client.channels.fetch(threadId);
    if (!thread) return;

    const STATUS_LABELS = {
      open:         '🔴 Open',
      acknowledged: '🟡 Acknowledged',
      in_progress:  '🔵 In progress',
      resolved:     '🟢 Resolved',
      closed:       '⚪ Closed'
    };

    const lines = [
      `**Status update for ${shortId}**`,
      `New status: ${STATUS_LABELS[newStatus] || newStatus}`,
    ];
    if (note) lines.push(`Note: ${note}`);

    await thread.send({ content: lines.join('\n') });
  } catch (err) {
    console.error(`Failed to post status update to ${threadId}:`, err.message);
  }
}

module.exports = { createReportThread, postStatusUpdate };
