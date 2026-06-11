import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const templateCommand = new SlashCommandBuilder()
  .setName('template')
  .setDescription('Replace this server with a Discord template snapshot.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('discordtemplate')
      .setDescription('Discord template link or code. This deletes current channels and non-managed roles.')
      .setRequired(true),
  );

export const commands = [templateCommand.toJSON()];
