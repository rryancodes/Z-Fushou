const { getStaleIssues, markReminded } = require('./issues');
const { buildTaggedHistory, detectBallHolder, unpinEscalationEmbed } = require('./context');
const { addNotifyJob, log: queueLog } = require('./queue');
const { getAllSupportRoleIds } = require('./speaker');
const pino = require('pino');

const log = pino({ level: 'info' }, pino.destination(1));

const REMINDER_MESSAGES = {
  staff: [
    `⚠️ <@&{roleId}> this issue has had no activity for 48 hours and may need attention.`,
    `Use \`/acknowledge {shortId}\` or reply in the thread to pick this up.`
  ],
  user: [
    `⚠️ <@{reporterId}> a team member asked for information earlier in this thread.`,
    `Please reply when you can so they can continue helping you.`
  ],
  staff_urgent: [
    `🔴 <@&{roleId}> URGENT — the user in this thread has been waiting and is expressing frustration.`,
    `No one has responded for 48+ hours. Please address this immediately.`
  ]
};

/**
 * Build department role ID for an issue.
 */
function getDeptRoleId(issue) {
  const DEPT_ROLES = {
    billing:      process.env.ROLE_BILLING,
    technical:    process.env.ROLE_TECHNICAL,
    product:      process.env.ROLE_PRODUCT,
    unclassified: process.env.ROLE_UNCLASSIFIED
  };
  const dept = issue.department || 'unclassified';
  return DEPT_ROLES[dept] || DEPT_ROLES.unclassified;
}

async function runReminderJob(client) {
  log.info('[reminders] Checking for stale issues...');

  const staleIssues = await getStaleIssues();

  if (staleIssues.length === 0) {
    log.info('[reminders] No stale issues found');
    return;
  }

  log.info(`[reminders] Found ${staleIssues.length} stale issue(s)`);

  const staffRoleIds = getAllSupportRoleIds();

  for (const issue of staleIssues) {
    if (!issue.thread_id) {
      log.warn({ shortId: issue.short_id }, '[reminders] No thread_id — skipping');
      continue;
    }

    let thread;
    try {
      thread = await client.channels.fetch(issue.thread_id);
    } catch (err) {
      log.error({ shortId: issue.short_id, err: err.message }, '[reminders] Could not fetch thread');
      continue;
    }

    if (!thread) continue;

    // V6.81: Determine ball-holder via LLM
    let target = 'staff';

    try {
      const threadMessages = await thread.messages.fetch({ limit: 100 });
      const msgArray = Array.from(threadMessages.values());
      const taggedHistory = buildTaggedHistory(msgArray, issue.user_discord_id, client.user.id);

      // Hard fallback: if no staff member has ever replied, always ping staff
      const hasStaffReply = msgArray.some(m =>
        !m.author.bot &&
        m.author.id !== issue.user_discord_id &&
        staffRoleIds.some(id => m.member?.roles.cache.has(id))
      );

      if (!hasStaffReply) {
        target = 'staff';
        log.info({ shortId: issue.short_id }, '[reminders] No staff reply ever — hard fallback to staff');
      } else {
        target = await detectBallHolder(taggedHistory);
        log.info({ shortId: issue.short_id, target }, '[reminders] LLM ball-holder detection');
      }
    } catch (err) {
      log.error({ shortId: issue.short_id, err: err.message }, '[reminders] Ball-holder detection failed — defaulting to staff');
      target = 'staff';
    }

    // Build and send reminder based on target
    const roleId = getDeptRoleId(issue);
    const template = REMINDER_MESSAGES[target] || REMINDER_MESSAGES.staff;
    const content = template.join('\n')
      .replace('{roleId}', roleId || '')
      .replace('{shortId}', issue.short_id)
      .replace('{reporterId}', issue.user_discord_id || '');

    try {
      await thread.send({ content });
    } catch (err) {
      log.error({ shortId: issue.short_id, err: err.message }, '[reminders] Failed to post reminder');
      continue;
    }

    // V6.81: Unpin escalation embed on reminder (staff has been re-notified)
    await unpinEscalationEmbed(thread);

    await markReminded(issue.id);

    log.info({ shortId: issue.short_id, target, count: (issue.reminder_count || 0) + 1 }, '[reminders] Reminded');

    await new Promise(r => setTimeout(r, 1000));
  }

  log.info('[reminders] Job complete');
}

module.exports = { runReminderJob };
