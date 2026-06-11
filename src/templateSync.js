const DISCORD_API_BASE = 'https://discord.com/api/v10';
const ADMINISTRATOR_PERMISSION = 8n;

const SUPPORTED_CHANNEL_TYPES = new Set([0, 2, 4, 5, 13, 15, 16]);
const ROLE_OVERWRITE = 0;
const CATEGORY_CHANNEL = 4;

export function extractTemplateCode(input) {
  const value = input.trim();

  if (!value) {
    throw new Error('Template link or code is required.');
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);

    if (hostname === 'discord.new' && parts[0]) {
      return validateTemplateCode(parts[0]);
    }

    if ((hostname === 'discord.com' || hostname === 'www.discord.com') && parts[0] === 'template' && parts[1]) {
      return validateTemplateCode(parts[1]);
    }
  } catch {
    // Plain template codes are handled below.
  }

  return validateTemplateCode(value);
}

export async function applyTemplateToGuild({ client, guild, templateCode, token, onProgress }) {
  const template = await fetchGuildTemplate(templateCode, token);
  const sourceGuild = template.serialized_source_guild;

  if (!sourceGuild?.roles?.length || !sourceGuild?.channels) {
    throw new Error('The template did not include a usable guild snapshot.');
  }

  await assertCanReplaceGuild({ client, guild, token });

  const stats = {
    templateName: template.name,
    deletedChannels: 0,
    deletedRoles: 0,
    createdChannels: 0,
    createdRoles: 0,
    warnings: [],
  };

  await onProgress?.('Updating server settings...');
  await patchGuildSettings(guild.id, sourceGuild, token);

  await onProgress?.('Deleting existing channels...');
  stats.deletedChannels = await deleteCurrentChannels(guild.id, token);

  await onProgress?.('Deleting existing non-managed roles...');
  stats.deletedRoles = await deleteCurrentRoles(guild.id, token);

  await onProgress?.('Creating template roles...');
  const roleResult = await createTemplateRoles(guild.id, sourceGuild.roles, token);
  stats.createdRoles = roleResult.createdCount;

  await onProgress?.('Creating template channels and permissions...');
  const channelResult = await createTemplateChannels(
    guild.id,
    sourceGuild.channels,
    roleResult.roleIdMap,
    token,
  );
  stats.createdChannels = channelResult.createdCount;
  stats.warnings.push(...channelResult.warnings);

  await onProgress?.('Finishing server settings...');
  const finalSettingsWarnings = await patchMappedGuildSettings(
    guild.id,
    sourceGuild,
    channelResult.channelIdMap,
    token,
  );
  stats.warnings.push(...finalSettingsWarnings);

  if (sourceGuild.icon_hash) {
    stats.warnings.push('Template icon hashes cannot be copied without the original image file.');
  }

  return stats;
}

async function fetchGuildTemplate(templateCode, token) {
  return apiRequest({
    method: 'GET',
    path: `/guilds/templates/${encodeURIComponent(templateCode)}`,
    token,
  });
}

async function assertCanReplaceGuild({ client, guild, token }) {
  const botMember = await guild.members.fetchMe({ force: true });

  if (!botMember.permissions.has(ADMINISTRATOR_PERMISSION)) {
    throw new Error('The bot needs Administrator permission in this server.');
  }

  const roles = await apiRequest({
    method: 'GET',
    path: `/guilds/${guild.id}/roles`,
    token,
  });

  const botRoleIds = new Set([guild.id, ...botMember.roles.cache.keys()]);
  const botHighestPosition = roles
    .filter((role) => botRoleIds.has(role.id))
    .reduce((highest, role) => Math.max(highest, role.position ?? 0), 0);

  const hasStableAdministrator = roles.some(
    (role) =>
      botRoleIds.has(role.id) &&
      role.managed &&
      hasPermission(role.permissions, ADMINISTRATOR_PERMISSION),
  );

  if (!hasStableAdministrator) {
    throw new Error(
      'Give the bot its Administrator permission on its own managed bot role before running this. Otherwise the bot could delete the role that grants its permission.',
    );
  }

  const blockingRoles = roles.filter(
    (role) => role.id !== guild.id && !role.managed && (role.position ?? 0) >= botHighestPosition,
  );

  if (blockingRoles.length) {
    throw new Error(
      `Move the bot role above these roles before running the command: ${blockingRoles
        .slice(0, 8)
        .map((role) => role.name)
        .join(', ')}${blockingRoles.length > 8 ? ', ...' : ''}`,
    );
  }

  if (!client.user) {
    throw new Error('Bot client is not ready.');
  }
}

async function patchGuildSettings(guildId, sourceGuild, token) {
  const body = cleanObject({
    name: sourceGuild.name,
    description: sourceGuild.description,
    verification_level: sourceGuild.verification_level,
    default_message_notifications: sourceGuild.default_message_notifications,
    explicit_content_filter: sourceGuild.explicit_content_filter,
    preferred_locale: sourceGuild.preferred_locale,
    afk_timeout: sourceGuild.afk_timeout,
    system_channel_flags: sourceGuild.system_channel_flags,
  });

  if (!Object.keys(body).length) {
    return;
  }

  await apiRequest({
    method: 'PATCH',
    path: `/guilds/${guildId}`,
    token,
    body,
    reason: 'Applying Discord template settings',
  });
}

async function patchMappedGuildSettings(guildId, sourceGuild, channelIdMap, token) {
  const warnings = [];
  const mappedSettings = {};

  for (const key of [
    'afk_channel_id',
    'system_channel_id',
    'rules_channel_id',
    'public_updates_channel_id',
    'safety_alerts_channel_id',
  ]) {
    const templateChannelId = sourceGuild[key];

    if (templateChannelId === null || templateChannelId === undefined) {
      mappedSettings[key] = null;
      continue;
    }

    const mappedChannelId = channelIdMap.get(String(templateChannelId));

    if (mappedChannelId) {
      mappedSettings[key] = mappedChannelId;
    } else {
      warnings.push(`Could not map guild setting ${key}.`);
    }
  }

  const entries = Object.entries(mappedSettings);

  if (!entries.length) {
    return warnings;
  }

  for (const [key, value] of entries) {
    try {
      await apiRequest({
        method: 'PATCH',
        path: `/guilds/${guildId}`,
        token,
        body: { [key]: value },
        reason: 'Applying Discord template channel settings',
      });
    } catch (error) {
      warnings.push(`Could not apply guild setting ${key}: ${error.message}`);
    }
  }

  return warnings;
}

async function deleteCurrentChannels(guildId, token) {
  const channels = await apiRequest({
    method: 'GET',
    path: `/guilds/${guildId}/channels`,
    token,
  });

  const sortedChannels = [...channels].sort((a, b) => {
    const aCategory = Number(a.type) === CATEGORY_CHANNEL ? 1 : 0;
    const bCategory = Number(b.type) === CATEGORY_CHANNEL ? 1 : 0;
    return aCategory - bCategory;
  });

  let deleted = 0;

  for (const channel of sortedChannels) {
    await apiRequest({
      method: 'DELETE',
      path: `/channels/${channel.id}`,
      token,
      reason: 'Replacing server with Discord template',
    });
    deleted += 1;
  }

  return deleted;
}

async function deleteCurrentRoles(guildId, token) {
  const roles = await apiRequest({
    method: 'GET',
    path: `/guilds/${guildId}/roles`,
    token,
  });

  const deletableRoles = roles
    .filter((role) => role.id !== guildId && !role.managed)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0));

  let deleted = 0;

  for (const role of deletableRoles) {
    await apiRequest({
      method: 'DELETE',
      path: `/guilds/${guildId}/roles/${role.id}`,
      token,
      reason: 'Replacing server with Discord template',
    });
    deleted += 1;
  }

  return deleted;
}

async function createTemplateRoles(guildId, templateRoles, token) {
  const roleIdMap = new Map([[String(0), guildId], [guildId, guildId]]);
  const everyoneRole = templateRoles.find((role) => String(role.id) === '0' || role.name === '@everyone');

  if (everyoneRole) {
    await apiRequest({
      method: 'PATCH',
      path: `/guilds/${guildId}/roles/${guildId}`,
      token,
      body: {
        permissions: normalizePermissions(everyoneRole.permissions),
      },
      reason: 'Applying template @everyone permissions',
    });
  }

  const rolesToCreate = templateRoles
    .map((role, index) => ({ role, index }))
    .filter(({ role }) => String(role.id) !== '0' && role.name !== '@everyone')
    .sort((a, b) => (a.role.position ?? a.index) - (b.role.position ?? b.index));
  const createdRoles = [];

  for (const { role: templateRole } of rolesToCreate) {
    const createdRole = await apiRequest({
      method: 'POST',
      path: `/guilds/${guildId}/roles`,
      token,
      body: cleanObject({
        name: templateRole.name,
        permissions: normalizePermissions(templateRole.permissions),
        color: templateRole.color,
        hoist: templateRole.hoist,
        mentionable: templateRole.mentionable,
        unicode_emoji: templateRole.unicode_emoji,
      }),
      reason: 'Creating Discord template role',
    });

    roleIdMap.set(String(templateRole.id), createdRole.id);
    createdRoles.push({ createdRole, templateRole });
  }

  if (createdRoles.length) {
    await apiRequest({
      method: 'PATCH',
      path: `/guilds/${guildId}/roles`,
      token,
      body: createdRoles.map(({ createdRole, templateRole }, index) => ({
        id: createdRole.id,
        position: templateRole.position ?? index + 1,
      })),
      reason: 'Ordering Discord template roles',
    });
  }

  return {
    roleIdMap,
    createdCount: createdRoles.length,
  };
}

async function createTemplateChannels(guildId, templateChannels, roleIdMap, token) {
  const channelIdMap = new Map();
  const warnings = [];
  const channelsToCreate = templateChannels
    .filter((channel) => SUPPORTED_CHANNEL_TYPES.has(Number(channel.type)))
    .sort((a, b) => {
      const aIsCategory = Number(a.type) === CATEGORY_CHANNEL ? 0 : 1;
      const bIsCategory = Number(b.type) === CATEGORY_CHANNEL ? 0 : 1;
      return aIsCategory - bIsCategory || (a.position ?? 0) - (b.position ?? 0);
    });

  const unsupportedChannels = templateChannels.filter((channel) => !SUPPORTED_CHANNEL_TYPES.has(Number(channel.type)));
  const memberOverwriteCount = templateChannels.reduce(
    (count, channel) =>
      count + (channel.permission_overwrites ?? []).filter((overwrite) => Number(overwrite.type) !== ROLE_OVERWRITE).length,
    0,
  );
  const missingRoleOverwriteCount = templateChannels.reduce(
    (count, channel) =>
      count + (channel.permission_overwrites ?? []).filter(
        (overwrite) => Number(overwrite.type) === ROLE_OVERWRITE && !roleIdMap.has(String(overwrite.id)),
      ).length,
    0,
  );
  const customEmojiCount = templateChannels.reduce((count, channel) => {
    const tagEmojiCount = (channel.available_tags ?? []).filter((tag) => tag.emoji_id).length;
    const defaultReactionCount = channel.default_reaction_emoji?.emoji_id ? 1 : 0;
    return count + tagEmojiCount + defaultReactionCount;
  }, 0);

  if (unsupportedChannels.length) {
    warnings.push(`Skipped ${unsupportedChannels.length} unsupported channel type(s).`);
  }

  if (memberOverwriteCount) {
    warnings.push(`Skipped ${memberOverwriteCount} member-specific channel overwrite(s).`);
  }

  if (missingRoleOverwriteCount) {
    warnings.push(`Skipped ${missingRoleOverwriteCount} channel overwrite(s) for missing template roles.`);
  }

  if (customEmojiCount) {
    warnings.push(`Skipped ${customEmojiCount} custom forum emoji reference(s).`);
  }

  const createdChannels = [];

  for (const templateChannel of channelsToCreate) {
    const parentId = templateChannel.parent_id === null || templateChannel.parent_id === undefined
      ? undefined
      : channelIdMap.get(String(templateChannel.parent_id));

    if (templateChannel.parent_id !== null && templateChannel.parent_id !== undefined && !parentId) {
      warnings.push(`Created "${templateChannel.name}" without its missing parent category.`);
    }

    const createdChannel = await apiRequest({
      method: 'POST',
      path: `/guilds/${guildId}/channels`,
      token,
      body: buildChannelCreateBody(templateChannel, parentId, roleIdMap),
      reason: 'Creating Discord template channel',
    });

    channelIdMap.set(String(templateChannel.id), createdChannel.id);
    createdChannels.push({ created: createdChannel, template: templateChannel });
  }

  if (createdChannels.length) {
    await apiRequest({
      method: 'PATCH',
      path: `/guilds/${guildId}/channels`,
      token,
      body: createdChannels.map(({ created, template }) =>
        cleanObject({
          id: created.id,
          position: template.position ?? 0,
          parent_id: template.parent_id === null || template.parent_id === undefined
            ? null
            : channelIdMap.get(String(template.parent_id)),
          lock_permissions: false,
        }),
      ),
      reason: 'Ordering Discord template channels',
    });
  }

  return {
    channelIdMap,
    createdCount: createdChannels.length,
    warnings,
  };
}

function buildChannelCreateBody(templateChannel, parentId, roleIdMap) {
  const type = Number(templateChannel.type);
  const body = cleanObject({
    name: templateChannel.name,
    type,
    position: templateChannel.position,
    parent_id: type === CATEGORY_CHANNEL ? undefined : parentId,
    permission_overwrites: buildPermissionOverwrites(templateChannel.permission_overwrites, roleIdMap),
  });

  if ([0, 5, 15, 16].includes(type)) {
    Object.assign(
      body,
      cleanObject({
        topic: templateChannel.topic,
        nsfw: templateChannel.nsfw,
        rate_limit_per_user: templateChannel.rate_limit_per_user,
        default_auto_archive_duration: templateChannel.default_auto_archive_duration,
        default_thread_rate_limit_per_user: templateChannel.default_thread_rate_limit_per_user,
      }),
    );
  }

  if ([2, 13].includes(type)) {
    Object.assign(
      body,
      cleanObject({
        bitrate: templateChannel.bitrate,
        user_limit: templateChannel.user_limit,
        rtc_region: templateChannel.rtc_region,
        video_quality_mode: templateChannel.video_quality_mode,
      }),
    );
  }

  if (type === CATEGORY_CHANNEL) {
    Object.assign(body, cleanObject({ nsfw: templateChannel.nsfw }));
  }

  if ([15, 16].includes(type) && Array.isArray(templateChannel.available_tags)) {
    body.available_tags = templateChannel.available_tags.map((tag) =>
      cleanObject({
        name: tag.name,
        moderated: tag.moderated,
        emoji_id: tag.emoji_id ? undefined : tag.emoji_id,
        emoji_name: tag.emoji_id ? undefined : tag.emoji_name,
      }),
    );
  }

  if ([15, 16].includes(type)) {
    Object.assign(
      body,
      cleanObject({
        default_sort_order: templateChannel.default_sort_order,
        default_forum_layout: templateChannel.default_forum_layout,
      }),
    );
  }

  if ([15, 16].includes(type) && templateChannel.default_reaction_emoji && !templateChannel.default_reaction_emoji.emoji_id) {
    body.default_reaction_emoji = cleanObject({
      emoji_id: templateChannel.default_reaction_emoji.emoji_id,
      emoji_name: templateChannel.default_reaction_emoji.emoji_name,
    });
  }

  return body;
}

function buildPermissionOverwrites(overwrites = [], roleIdMap) {
  return overwrites
    .filter((overwrite) => Number(overwrite.type) === ROLE_OVERWRITE)
    .map((overwrite) => {
      const mappedRoleId = roleIdMap.get(String(overwrite.id));

      if (!mappedRoleId) {
        return null;
      }

      return {
        id: mappedRoleId,
        type: ROLE_OVERWRITE,
        allow: normalizePermissions(overwrite.allow),
        deny: normalizePermissions(overwrite.deny),
      };
    })
    .filter(Boolean);
}

async function apiRequest({ method, path, token, body, reason, attempt = 0 }) {
  const headers = {
    Authorization: `Bot ${token}`,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (reason) {
    headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
  }

  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 429 && attempt < 5) {
    const data = await response.json().catch(() => ({}));
    const retryAfterMs = Math.ceil(Number(data.retry_after ?? 1) * 1000);
    await delay(retryAfterMs);
    return apiRequest({ method, path, token, body, reason, attempt: attempt + 1 });
  }

  if (response.status === 204) {
    return null;
  }

  const responseText = await response.text();
  const data = responseText ? parseJson(responseText) : null;

  if (!response.ok) {
    const details = data?.message ? `: ${data.message}` : responseText ? `: ${responseText}` : '';
    throw new Error(`Discord API ${method} ${path} failed with ${response.status}${details}`);
  }

  return data;
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasPermission(value, permission) {
  return (BigInt(value ?? 0) & permission) === permission;
}

function normalizePermissions(value) {
  return BigInt(value ?? 0).toString();
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function validateTemplateCode(value) {
  const code = value.trim();

  if (!/^[A-Za-z0-9_-]{2,100}$/.test(code)) {
    throw new Error('Use a valid Discord template link or template code.');
  }

  return code;
}
