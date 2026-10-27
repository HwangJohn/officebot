import { Client, Events, GatewayIntentBits, REST } from 'discord.js';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startupCatchUp, startupCatchUpEnabled, createClaimStore, createDiscordBusinessBridge, createDiscordChat, createDiscordOwnerContextLoader, createOpenAIAnswer, createChatDiagnostics, messageContentEnabled, replyOptions, toIncoming } from './discordChat.js';
import { DISCORD_BUSINESS_SCOPE, DISCORD_BUSINESS_BOT_ID, hasDiscordScope, verifyDiscordIdentity } from './discordScope.js';
import { createNotificationBridge, createNotificationPump, createNotificationReconciler } from './discordNotificationTransport.js';

async function main() {
  const businessActivatedAt = Date.now();
  if (!hasDiscordScope()) throw new Error('discord_scope_missing_or_invalid');
  const token = process.env.DISCORD_BOT_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!token || !apiKey) throw new Error('discord_credentials_missing');
  const record = { ...DISCORD_BUSINESS_SCOPE, botId: DISCORD_BUSINESS_BOT_ID };
  const rest = new REST({ version: '10' }).setToken(token);
  const discordGet = async (_token: string, endpoint: string): Promise<any> => rest.get(endpoint as `/${string}`);
  const flags = await verifyDiscordIdentity(record, endpoint => discordGet(token, endpoint));
  const plainInput = messageContentEnabled(flags);
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, ...(plainInput ? [GatewayIntentBits.MessageContent] : [])], allowedMentions: { parse: [], repliedUser: false } });
  let handledCount = 0, replyCount = 0, lastMessageId: string | null = null, lastOrigin: 'gateway' | 'catchup' | null = null, lastHandledAt: string | null = null;
  let catchupStatus: 'pending' | 'complete' | 'failed' | 'disabled' = 'pending';
  let businessConfigured = false, notificationsEnabled = false;
  const chatDiagnostics = createChatDiagnostics();
  const server = createServer((req, res) => { if (req.url !== '/health' || req.method !== 'GET') { res.writeHead(404).end(); return; } res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ready: client.isReady() && client.user?.id === record.botId, botId: record.botId, guildId: record.guildId, channelId: record.channelId, handledCount, replyCount, lastMessageId, lastOrigin, lastHandledAt, catchupStatus, businessConfigured, notificationsEnabled, lastChatFailure: chatDiagnostics.snapshot(), input: plainInput ? 'plain' : 'mention', stateEndpoint: '127.0.0.1:4317' })); });
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(4328, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); }); });
  mkdirSync(resolve('data'), { recursive: true });
  const store = createClaimStore(resolve('data/discord-seen.sqlite'));
  const channel = async () => {
    const c = await client.channels.fetch(record.channelId);
    if (!c || !c.isTextBased() || !('send' in c) || !('guildId' in c) || c.guildId !== record.guildId) throw new Error('scope');
    return c;
  };
  const bridgeToken = process.env.WORK_ASSISTANT_DISCORD_BRIDGE_TOKEN;
  const bridgeConfigured = bridgeToken && bridgeToken.length >= 32 && record.guildId === DISCORD_BUSINESS_SCOPE.guildId && record.channelId === DISCORD_BUSINESS_SCOPE.channelId;
  const reconcile = bridgeConfigured && bridgeToken ? createNotificationReconciler(createNotificationBridge('http://127.0.0.1:4317/api/discord/business', bridgeToken), messageId => discordGet(token, `/channels/${DISCORD_BUSINESS_SCOPE.channelId}/messages/${messageId}`), record.botId) : undefined;
  const business = bridgeConfigured && bridgeToken ? { ownerId: DISCORD_BUSINESS_SCOPE.ownerId, activatedAt: businessActivatedAt, run: createDiscordBusinessBridge('http://127.0.0.1:4317/api/discord/business', bridgeToken, fetch, reconcile) } : undefined;
  const contextLoader = createDiscordOwnerContextLoader('http://127.0.0.1:4317/api/discord/business', business ? bridgeToken : undefined);
  const notificationPump = business && bridgeToken && process.env.WORK_ASSISTANT_DISCORD_NOTIFICATIONS === '1' ? createNotificationPump(createNotificationBridge('http://127.0.0.1:4317/api/discord/business', bridgeToken), async content => {
    const c = await channel();
    const sent = await c.send({ content, allowedMentions: { parse: [], repliedUser: false } });
    return { id: sent.id, channelId: sent.channelId, authorId: sent.author.id };
  }, record.botId) : undefined;
  businessConfigured = Boolean(business);
  notificationsEnabled = Boolean(notificationPump);
  const notificationTimer = notificationPump ? setInterval(() => { if (client.isReady()) void notificationPump().catch(() => console.error('DISCORD_NOTIFICATION_FAILED')); }, 15_000) : undefined;
  notificationTimer?.unref();
  const handle = createDiscordChat({ guildId: record.guildId, channelId: record.channelId, requireMention: !plainInput, claim: id => store.claim(id), history: store, business, onFailureStage: (stage, category) => { chatDiagnostics.record(stage, category); console.error(`DISCORD_CHAT_${stage.toUpperCase()}_FAILED`); }, onProcessing: m => { handledCount++; lastMessageId = m.id; lastOrigin = m.origin; lastHandledAt = new Date().toISOString(); }, answer: createOpenAIAnswer(apiKey, contextLoader, [token, bridgeToken ?? '']), secrets: [token, apiKey, bridgeToken ?? ''], send: async (text, message) => { const c = await channel(); await c.send(replyOptions(text, message.id)); replyCount++; } });
  client.on(Events.MessageCreate, message => {
    if (!client.user) return;
    void handle(toIncoming(message, client.user.id, 'gateway'));
  });
  client.on(Events.Error, () => { console.error('DISCORD_GATEWAY_ERROR'); });
  client.once(Events.ClientReady, ready => {
    if (ready.user.id !== record.botId) { console.error('BOT_ID_MISMATCH'); process.exit(1); }
    console.log(plainInput ? 'DISCORD_GATEWAY_READY_PLAIN' : 'DISCORD_GATEWAY_READY_MENTION_FALLBACK');
    void (async () => {
      try {
        catchupStatus = await startupCatchUp(startupCatchUpEnabled(process.env.WORK_ASSISTANT_DISCORD_CATCHUP), async () => {
          const c = await channel();
          const messages = await c.messages.fetch({ limit: 20 });
          return [...messages.values()];
        }, ready.user.id, handle);
      } catch { catchupStatus = 'failed'; console.error('DISCORD_CATCHUP_FAILED'); }
    })();
  });
  process.once('SIGINT', () => { if (notificationTimer) clearInterval(notificationTimer); client.destroy(); server.close(); store.close(); });
  process.once('SIGTERM', () => { if (notificationTimer) clearInterval(notificationTimer); client.destroy(); server.close(); store.close(); });
  try { await client.login(token); } catch { console.error(plainInput ? 'DISCORD_LOGIN_FAILED_CHECK_MESSAGE_CONTENT_INTENT' : 'DISCORD_LOGIN_FAILED'); throw new Error('login_failed'); }
}
process.on('unhandledRejection', () => { console.error('DISCORD_RUNTIME_FAILED'); process.exit(1); });
main().catch((error: unknown) => { const code = error instanceof Error ? error.message : ''; const safe = ['discord_scope_missing_or_invalid', 'discord_credentials_missing', 'discord_bot_identity_mismatch', 'discord_channel_scope_mismatch']; console.error(safe.includes(code) ? code : 'DISCORD_RUNTIME_FAILED'); process.exit(1); });
