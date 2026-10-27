import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDiscordScope, DISCORD_BUSINESS_SCOPE as scope, DISCORD_BUSINESS_BOT_ID as bot } from '../src/discordScope.js';
import { buildServer } from '../src/server.js';

test('business bridge rejects each incomplete scope and accepts the configured scope only', async () => {
  const token = 'x'.repeat(40);
  assert.equal(hasDiscordScope(scope, bot), true);
  for (const field of ['ownerId', 'guildId', 'channelId'] as const) assert.equal(hasDiscordScope({ ...scope, [field]: '' }, bot), false);
  assert.equal(hasDiscordScope(scope, ''), false);
  const body = { action: 'goals', authorId: scope.ownerId, guildId: scope.guildId, channelId: scope.channelId };
  for (const field of ['ownerId', 'guildId', 'channelId'] as const) {
    const app = buildServer({ dbPath: ':memory:', discordBridge: { token, ...scope, [field]: '' } });
    try { const r = await app.inject({ method: 'POST', url: '/api/discord/business', headers: { 'x-work-assistant-discord-bridge': token }, payload: body }); assert.equal(r.statusCode, 403); } finally { await app.close(); }
  }
  const app = buildServer({ dbPath: ':memory:', discordBridge: { token, ...scope } });
  try { const r = await app.inject({ method: 'POST', url: '/api/discord/business', headers: { 'x-work-assistant-discord-bridge': token }, payload: body }); assert.equal(r.statusCode, 200); } finally { await app.close(); }
});
