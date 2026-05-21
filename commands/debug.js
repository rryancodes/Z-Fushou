const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const supabase = require('../lib/supabase');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('debug')
    .setDescription('Debug: look up recent issues in DB (team only)')
    .addStringOption(opt =>
      opt.setName('search')
        .setDescription('Part of an issue ID or title to search for')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const search = interaction.options.getString('search') || '';

    let query = supabase
      .from('issues')
      .select('short_id, title, status, department, user_discord_id, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    if (search) {
      query = query.ilike('short_id', `%${search}%`);
    }

    const { data, error } = await query;

    if (error) {
      return interaction.editReply({ content: `DB error: ${error.message}` });
    }

    if (!data || data.length === 0) {
      return interaction.editReply({ content: `No issues found${search ? ` matching "${search}"` : ''}.` });
    }

    const lines = [`**Recent issues in DB (${data.length}):**`, ``];
    for (const issue of data) {
      lines.push(`\`${issue.short_id}\` — ${issue.title}`);
      lines.push(`  Status: ${issue.status} | Dept: ${issue.department} | User: <@${issue.user_discord_id}>`);
      lines.push('');
    }

    await interaction.editReply({ content: lines.join('\n') });
  }
};