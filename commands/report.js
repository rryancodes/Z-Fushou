const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Report an issue with the product'),

  async execute(interaction) {
    // MVP GUARD: /report disabled — ticketing and support workflow logic turned off
    return interaction.reply({
      content: 'Issue reporting is temporarily disabled during maintenance. Please try again later.',
      flags: MessageFlags.Ephemeral
    });

    const modal = new ModalBuilder()
      .setCustomId('report_modal')
      .setTitle('Report an Issue');

    const titleInput = new TextInputBuilder()
      .setCustomId('issue_title')
      .setLabel('What is the issue? (short summary)')
      .setStyle(TextInputStyle.Short)
      .setMaxLength(100)
      .setRequired(true);

    const descInput = new TextInputBuilder()
      .setCustomId('issue_description')
      .setLabel('Describe the problem in detail')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1000)
      .setRequired(true);

    const stepsInput = new TextInputBuilder()
      .setCustomId('issue_steps')
      .setLabel('Steps you already tried (if any)')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(500)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(descInput),
      new ActionRowBuilder().addComponents(stepsInput)
    );

    await interaction.showModal(modal);
  }
};
