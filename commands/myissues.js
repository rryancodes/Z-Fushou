const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getUserOpenIssues } = require('../lib/issues');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('myissues')
    .setDescription('List all your open issues'),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const issues = await getUserOpenIssues(interaction.user.id);

    if (issues.length === 0) {
      return interaction.editReply({
        content: `You have no open issues right now.`
      });
    }

    const lines = [`**Your open issues (${issues.length}):**`, ``];

    for (const issue of issues) {
      const date = new Date(issue.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      lines.push(`**${issue.short_id}** — ${issue.title}`);
      lines.push(`  Status: ${issue.status}  |  Dept: ${issue.department}  |  Opened: ${date}`);
      lines.push('');
    }

    lines.push(`Use \`/status ISS-xxxx\` for full details on any issue.`);

    await interaction.editReply({ content: lines.join('\n') });
  }
};
