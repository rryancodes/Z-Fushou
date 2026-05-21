const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check if the bot is alive'),

  async execute(interaction) {
    const sent = await interaction.reply({
      content:    'Pinging...',
      fetchReply: true,
      flags:      MessageFlags.Ephemeral
    });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    await interaction.editReply(`Bot is online. Latency: ${latency}ms.`);
  }
};