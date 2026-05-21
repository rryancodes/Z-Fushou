async function notifyUser(client, issue, newStatus, note) {
  const STATUS_LABELS = {
    open:         '🔴 Open',
    acknowledged: '🟡 Acknowledged — a team member has seen your issue',
    in_progress:  '🔵 In progress — someone is actively working on this',
    resolved:     '🟢 Resolved',
    closed:       '⚪ Closed'
  };

  const label = STATUS_LABELS[newStatus] || newStatus;

  const threadLines = [
    `**Update on ${issue.short_id}**`,
    ``,
    `Status: ${label}`,
  ];

  if (note) threadLines.push(``, `Note from team: ${note}`);

  if (newStatus === 'resolved' || newStatus === 'closed') {
    threadLines.push(``, `If your issue persists or comes back, feel free to file a new report.`);
  }

  // 1. Post inside the issue thread
  if (issue.thread_id) {
    try {
      const thread = await client.channels.fetch(issue.thread_id);
      if (thread) {
        await thread.send({ content: threadLines.join('\n') });
      }
    } catch (err) {
      console.error(`Failed to notify in thread ${issue.thread_id}:`, err.message);
    }
  }

  // 2. DM the user directly
  // Note: DMs silently fail if the user has DMs disabled (error code 50007) — not critical
  try {
    const user = await client.users.fetch(issue.user_discord_id);
    if (!user) return;

    const dmLines = [
      `**Update on your issue ${issue.short_id}** — "${issue.title}"`,
      ``,
      `Status: ${label}`,
    ];

    if (note) dmLines.push(``, `Note from team: ${note}`);

    if (newStatus === 'resolved' || newStatus === 'closed') {
      dmLines.push(``, `If your issue comes back, file a new report in the server.`);
    }

    await user.send({ content: dmLines.join('\n') });
  } catch (err) {
    if (err.code === 50007) {
      console.warn(`User ${issue.user_discord_id} has DMs disabled — skipping DM`);
    } else {
      console.error(`Failed to DM user ${issue.user_discord_id}:`, err.message);
    }
  }
}

module.exports = { notifyUser };