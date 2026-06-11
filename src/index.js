import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';
import { applyTemplateToGuild, extractTemplateCode } from './templateSync.js';

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error('DISCORD_TOKEN must be set in .env before starting the bot.');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const activeGuildRuns = new Set();

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'template') {
    return;
  }

  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply({ content: 'Run this command inside a server.', ephemeral: true });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: 'You need Administrator permission to use this command.', ephemeral: true });
    return;
  }

  if (activeGuildRuns.has(interaction.guildId)) {
    await interaction.reply({
      content: 'A template apply operation is already running in this server.',
      ephemeral: true,
    });
    return;
  }

  const input = interaction.options.getString('discordtemplate', true);
  let code;

  try {
    code = extractTemplateCode(input);
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
    return;
  }

  activeGuildRuns.add(interaction.guildId);

  try {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply('Fetching template and checking permissions...');

    const result = await applyTemplateToGuild({
      client,
      guild: interaction.guild,
      templateCode: code,
      token,
      onProgress: async (message) => {
        try {
          await interaction.editReply(message);
        } catch {
          // The original channel can be deleted during the run; the operation can still continue.
        }
      },
    });

    const warningText = result.warnings.length
      ? `\nWarnings:\n${result.warnings.map((warning) => `- ${warning}`).join('\n')}`
      : '';

    await interaction.editReply(
      [
        `Applied template "${result.templateName}".`,
        `Deleted ${result.deletedChannels} channel(s) and ${result.deletedRoles} role(s).`,
        `Created ${result.createdChannels} channel(s) and ${result.createdRoles} role(s).`,
        warningText,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  } catch (error) {
    console.error(error);

    const message = error instanceof Error ? error.message : 'Unknown error.';

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`Template apply failed: ${message}`);
      } else {
        await interaction.reply({ content: `Template apply failed: ${message}`, ephemeral: true });
      }
    } catch {
      console.error('Failed to report command failure to Discord.');
    }
  } finally {
    activeGuildRuns.delete(interaction.guildId);
  }
});

client.login(token);
