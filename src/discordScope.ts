// No identities are enabled unless every value is explicitly configured.
export const DISCORD_BUSINESS_SCOPE = {
  ownerId: process.env.WORK_ASSISTANT_DISCORD_OWNER_ID ?? '',
  guildId: process.env.WORK_ASSISTANT_DISCORD_GUILD_ID ?? '',
  channelId: process.env.WORK_ASSISTANT_DISCORD_CHANNEL_ID ?? ''
};
export const DISCORD_BUSINESS_BOT_ID = process.env.DISCORD_BOT_ID ?? '';
export function hasDiscordScope(scope = DISCORD_BUSINESS_SCOPE, botId = DISCORD_BUSINESS_BOT_ID): boolean {
  return [scope.ownerId, scope.guildId, scope.channelId, botId].every(value => /^\d{15,22}$/.test(value));
}

// The transport is injected so the startup checks can be tested without network access.
export async function verifyDiscordIdentity(record: typeof DISCORD_BUSINESS_SCOPE & { botId: string }, get: (path: string) => Promise<any>): Promise<number> {
  if (!hasDiscordScope(record, record.botId)) throw new Error('discord_scope_missing_or_invalid');
  const [user, app, channel] = await Promise.all([get('/users/@me'), get('/applications/@me'), get(`/channels/${record.channelId}`)]);
  if (user?.id !== record.botId || user?.bot !== true || app?.id !== record.botId || !Number.isSafeInteger(app.flags)) throw new Error('discord_bot_identity_mismatch');
  if (channel?.id !== record.channelId || channel?.guild_id !== record.guildId || ![0, 5].includes(channel.type)) throw new Error('discord_channel_scope_mismatch');
  return app.flags;
}
