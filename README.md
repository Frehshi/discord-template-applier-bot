# Discord Template Applier Bot

Admin-only Discord bot with:

```text
/template discordtemplate:<discord.new link or template code>
```

The command deletes the current server channels and non-managed roles, then recreates the roles, role permissions, channels, channel overwrites, and supported guild settings from the template snapshot.

## Setup

1. Install Node.js 18.17 or newer.
2. Create a Discord application and bot in the Discord Developer Portal.
3. Invite the bot with `bot` and `applications.commands` scopes, and give the bot Administrator permission.
4. Put the bot's own managed bot role above every role it needs to delete.
5. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `CLIENT_ID`.
6. Run:

```bash
npm install
npm run deploy
npm start
```

Set `GUILD_ID` in `.env` before `npm run deploy` if you want the slash command to appear instantly in one test server. Without `GUILD_ID`, it deploys globally.

## Discord limitations

Discord does not provide an API endpoint that directly applies a template to an existing server. This bot fetches the template snapshot and recreates what Discord exposes in that snapshot.

It cannot copy messages, members, invites, emojis, stickers, integrations, webhooks, bots, or the server icon image from only the template hash. It also cannot delete managed integration/bot roles or roles above the bot.
