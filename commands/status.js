const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getIssueByShortId } = require('../lib/issues');

const STATUS_LABELS = {
  open:          '🔴 Open',
  acknowledged:  '🟡 Acknowledged',
  in_progress:   '🔵 In progress',
  resolved:      '🟢 Resolved',
  closed:        '⚪ Closed'
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check the status of your issue')
    .addStringOption(opt =>
      opt.setName('issue_id')
        .setDescription('Your issue ID e.g. ISS-1001')
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const issueId = interaction.options.getString('issue_id');
    const issue = await getIssueByShortId(issueId);

    if (!issue) {
      return interaction.editReply({
        content: `No issue found with ID **${issueId}**. Double-check the ID and try again.`
      });
    }

    // Only let the owner see their own issue
    if (issue.user_discord_id !== interaction.user.id) {
      return interaction.editReply({
        content: `You can only check the status of your own issues.`
      });
    }

    const created  = new Date(issue.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const updated  = new Date(issue.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const statusLabel = STATUS_LABELS[issue.status] || issue.status;

    const lines = [
      `**${issue.short_id}** — ${issue.title}`,
      ``,
      `Status:      ${statusLabel}`,
      `Department:  ${issue.department}`,
      `Reported:    ${created}`,
      `Last update: ${updated}`,
    ];

    if (issue.thread_id) {
      lines.push(`Thread:      <#${issue.thread_id}>`);
    }

    await interaction.editReply({ content: lines.join('\n') });
  }
};
