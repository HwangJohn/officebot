import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../src/server.js';
import { createNotificationBridge, createNotificationPump, createNotificationReconciler } from '../src/discordNotificationTransport.js';
import { DISCORD_BUSINESS_BOT_ID as botId, DISCORD_BUSINESS_SCOPE as scope } from '../src/discordScope.js';

test('bridge sends one scoped batch and reconciles all its held members using fetched evidence after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-bridge-')), dbPath = join(dir, 'test.sqlite');
  const token = 'test-only-bridge-token-xxxxxxxxxxxxxxxx';
  let time = Date.parse('2026-10-27T09:00:00Z'), app = buildServer({ dbPath, discordBridge: { ...scope, token }, schedulerClock: () => time });
  const post = async (url: string, payload: object) => { const response = await app.inject({ method: 'POST', url, payload }); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  const fetcher: typeof fetch = async (_url, init) => { const r = await app.inject({ method: 'POST', url: '/api/discord/business', headers: init?.headers as Record<string, string>, payload: init?.body as string }); return new Response(r.body, { status: r.statusCode }); };
  const bridge = createNotificationBridge('http://127.0.0.1:4317/api/discord/business', token, fetcher);
  let remote: any, sends = 0, reads = 0;
  try {
    const events = [];
    for (let i = 0; i < 3; i++) events.push(await post('/api/mock-events', { source: 'outlook', account: 'mock:test', project: 'batch', externalId: `thread-${i}`, revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert', details: { subject: 'Review', body: 'Please review.' } }));
    const goal = await post('/api/goals', { project: 'batch', title: 'Review', completion: 'Draft' });
    await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    await post(`/api/goals/${goal.id}/step`, { version: 1 }); await post(`/api/goals/${goal.id}/step`, { version: 1 });
    const detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    await post(`/api/goals/${goal.id}/notifications`, { enabled: true });
    for (const event of events) await post(`/api/goals/${goal.id}/approvals`, { artifactId: detail.artifacts[0].id, targetEventId: event.eventId });
    const pump = createNotificationPump(bridge, async content => { sends++; remote = { id: '100000000000000010', channel_id: scope.channelId, author: { id: botId, bot: true }, webhook_id: null, content, timestamp: new Date(time).toISOString() }; throw new Error('receipt lost'); }, botId);
    await pump(); await pump();
    let rows = (await app.inject(`/api/goals/${goal.id}/notifications`)).json().notifications;
    assert.equal(sends, 1); assert.equal(rows.filter((row: any) => row.status === 'held').length, 3);
    for (const row of rows) assert.ok(remote.content.includes(row.id) && remote.content.includes(row.approval_id));
    await app.close(); time += 1000; app = buildServer({ dbPath, discordBridge: { ...scope, token }, schedulerClock: () => time });
    const reconcile = createNotificationReconciler(bridge, async id => { reads++; assert.equal(id, remote.id); return remote; }, botId);
    assert.equal((await reconcile(rows[1].id, remote.id, '100000000000000008')).status, 'sent');
    rows = (await app.inject(`/api/goals/${goal.id}/notifications`)).json().notifications;
    assert.ok(rows.every((row: any) => row.status === 'sent' && row.discord_message_id === remote.id));
    assert.equal((await reconcile(rows[2].id, remote.id, '100000000000000011')).status, 'sent');
    assert.equal(reads, 1); assert.equal(sends, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
