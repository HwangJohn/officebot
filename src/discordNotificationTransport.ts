import { DISCORD_BUSINESS_BOT_ID, DISCORD_BUSINESS_SCOPE as scope } from './discordScope.js';

type Claim = { id: string; content: string; token: string; scope: typeof scope };
type Bridge = (body: Record<string, unknown>) => Promise<any>;

export function createNotificationBridge(url: string, token: string, fetcher: typeof fetch = fetch): Bridge {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '4317' || endpoint.pathname !== '/api/discord/business' || token.length < 32) throw new Error('invalid_business_endpoint');
  return async body => {
    const response = await fetcher(endpoint, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json', 'x-work-assistant-discord-bridge': token }, body: JSON.stringify({ ...body, authorId: scope.ownerId, guildId: scope.guildId, channelId: scope.channelId }) });
    if (!response.ok) throw new Error('notification_bridge_failed');
    return response.json();
  };
}

// The caller supplies the fixed-channel Discord send operation. A failure after
// dispatch is always uncertain, including an invalid or lost receipt.
export function createNotificationPump(bridge: Bridge, send: (content: string) => Promise<{ id: string; channelId: string; authorId: string }>, botId: string) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const claim: Claim | null = (await bridge({ action: 'notification_claim' })).notification;
      if (!claim) return;
      let messageId: string | undefined;
      try {
        if (claim.scope?.ownerId !== scope.ownerId || claim.scope?.guildId !== scope.guildId || claim.scope?.channelId !== scope.channelId || typeof claim.content !== 'string' || claim.content.length > 1800) throw new Error('invalid_claim');
        const sent = await send(claim.content);
        if (sent.channelId !== scope.channelId || sent.authorId !== botId || !/^\d{15,22}$/.test(sent.id)) throw new Error('invalid_receipt');
        messageId = sent.id;
      } catch { /* held until independently reconciled */ }
      await bridge({ action: 'notification_finish', notificationId: claim.id, claimToken: claim.token, status: messageId ? 'sent' : 'unknown', ...(messageId ? { messageId } : {}) });
    } finally { running = false; }
  };
}

// Evidence comes from a bot-authenticated Discord GET, not the owner's text.
// No matching message or a failed lookup leaves the outcome held.
export function createNotificationReconciler(bridge: Bridge, getMessage: (messageId: string) => Promise<any>, botId: string) {
  if (botId !== DISCORD_BUSINESS_BOT_ID) throw new Error('invalid_bot_scope');
  return async (notificationId: string, messageId: string, commandMessageId: string) => {
    if (!/^notification-[0-9a-f-]{36}$/.test(notificationId) || !/^\d{15,22}$/.test(messageId) || !/^\d{15,22}$/.test(commandMessageId)) throw new Error('invalid_reconciliation_request');
    const expected = await bridge({ action: 'notification_lookup', notificationId });
    if (expected.status === 'sent') return { status: expected.messageId === messageId ? 'sent' as const : 'held' as const };
    if (expected.status !== 'held') throw new Error('notification_not_held');
    let message: any;
    try { message = await getMessage(messageId); } catch { return { status: 'held' as const }; }
    if (!message || message.id !== messageId || message.channel_id !== scope.channelId || message.author?.id !== botId || message.author?.bot !== true || message.webhook_id != null || message.content !== expected.content || !Number.isFinite(Date.parse(message.timestamp)) || Date.parse(message.timestamp) < expected.createdAt) return { status: 'held' as const };
    return bridge({ action: 'notification_reconcile', notificationId, commandMessageId, receipt: { id: message.id, channel_id: message.channel_id, author: { id: message.author.id, bot: message.author.bot }, webhook_id: message.webhook_id ?? null, content: message.content, timestamp: message.timestamp } });
  };
}
