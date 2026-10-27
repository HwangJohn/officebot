import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { createDiscordBusinessBridge, createDiscordChat } from '../src/discordChat.js';
import { DISCORD_BUSINESS_SCOPE as scope } from '../src/discordScope.js';
import type { PlannerAdapter } from '../src/workflow.js';

test('owner creates and advances project goals through Discord with durable scoped, correctable memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-goals-')); const dbPath = join(dir, 'test.sqlite'); const token = 'x'.repeat(40);
  const seen: Parameters<PlannerAdapter>[0][] = [];
  const adapter: PlannerAdapter = async input => { seen.push(input); return { steps: [
    { id: 'fact', dependsOn: [], tool: 'record_fact', input: input.facts[0] },
    { id: 'draft', dependsOn: ['fact'], tool: 'create_artifact', input: { kind: 'draft', content: 'Local review draft', factStepId: 'fact' } }
  ] }; };
  const opts = { dbPath, discordBridge: { ...scope, token }, plannerAdapterFactory: () => adapter };
  let app = buildServer(opts);
  const post = async (url: string, payload: Record<string, unknown>) => { const r = await app.inject({ method: 'POST', url, payload }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
  let bridgeCalls = 0; const replies: string[] = []; const claims = new Set<string>(); const activatedAt = Date.now();
  const fetcher: typeof fetch = async (_url, init) => { bridgeCalls++; const r = await app.inject({ method: 'POST', url: '/api/discord/business', headers: init?.headers as Record<string, string>, payload: init?.body as string }); return new Response(r.body, { status: r.statusCode, headers: { 'content-type': 'application/json' } }); };
  const run = createDiscordBusinessBridge('http://127.0.0.1:4317/api/discord/business', token, fetcher);
  const handle = createDiscordChat({ guildId: scope.guildId, channelId: scope.channelId, claim: id => !claims.has(id) && !!claims.add(id), business: { ownerId: scope.ownerId, activatedAt, run }, answer: async () => 'chat', send: async text => { replies.push(text); } });
  const message = (id: string, text: string, userId: string = scope.ownerId) => ({ id, text, userId, guildId: scope.guildId, channelId: scope.channelId, bot: false, webhook: false, mentioned: false, origin: 'gateway' as const, createdTimestamp: activatedAt + 1 });
  try {
    const record = { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'alpha', text: 'Actual alpha source' } };
    await post('/api/mock-events', record);
    await post('/api/mock-events', { ...record, project: 'beta', details: { channel: 'beta', text: 'Beta evidence' } });
    await handle(message('1', '!목표생성 alpha | Alpha | Draft', '100000000000000005'));
    await handle({ ...message('2', '!목표생성 alpha | Alpha | Draft'), origin: 'catchup' });
    assert.equal(bridgeCalls, 0); assert.equal((await app.inject('/api/goals')).json().length, 0);
    await handle(message('3', '!목표생성 missing | Goal | Draft'));
    assert.match(replies.at(-1)!, /프로젝트를 정확히/); assert.equal((await app.inject('/api/goals')).json().length, 0);
    await handle(message('4', '!목표생성 alpha | Alpha plan | Review draft'));
    const goals = (await app.inject('/api/goals')).json(); assert.equal(goals.length, 1); const goalId = goals[0].id;
    assert.match(replies.at(-1)!, new RegExp(goalId));
    const headers = { 'x-work-assistant-discord-bridge': token };
    const createPayload = { action: 'create_goal', messageId: '4', project: 'alpha', title: 'Alpha plan', completion: 'Review draft', authorId: scope.ownerId, guildId: scope.guildId, channelId: scope.channelId };
    assert.equal((await app.inject({ method: 'POST', url: '/api/discord/business', headers, payload: createPayload })).json().goalId, goalId);
    assert.notEqual((await app.inject({ method: 'POST', url: '/api/discord/business', headers, payload: { ...createPayload, title: 'different' } })).statusCode, 200);
    assert.equal((await app.inject('/api/goals')).json().length, 1);
    await handle(message('5', '!기억 alpha | Supplier might quote 99; please verify'));
    await handle(message('6', `!계획 ${goalId}`));
    assert.equal(seen.length, 1); assert.ok(seen[0].memory.conversation.some(m => m.content.includes('quote 99')));
    assert.ok(seen[0].facts.every(f => !f.value.includes('99')));
    await handle(message('7', `!진행 ${goalId}`)); await handle(message('8', `!진행 ${goalId}`));
    assert.equal((await app.inject(`/api/goals/${goalId}`)).json().artifacts.length, 1);
    const repeat = { action: 'step_goal', messageId: '8', goalId, authorId: scope.ownerId, guildId: scope.guildId, channelId: scope.channelId };
    assert.equal((await app.inject({ method: 'POST', url: '/api/discord/business', headers, payload: repeat })).json().stepId, 'draft');
    assert.equal((await app.inject(`/api/goals/${goalId}`)).json().artifacts.length, 1);
    await app.close(); app = buildServer(opts);
    await handle(message('9', `!계획 ${goalId}`));
    assert.ok(seen[1].memory.conversation.some(m => m.content.includes('quote 99')));
    const source = encodeURIComponent('discord:message:5');
    await post(`/api/project-messages/${source}/correction`, { project: 'alpha', expectedVersion: 1, content: null });
    await handle(message('10', `!계획 ${goalId}`));
    assert.ok(seen[2].memory.conversation.every(m => !m.content.includes('quote 99')));
    assert.equal((await app.inject('/api/project-messages?project=beta')).json().length, 0);
    const changed = await post('/api/mock-events', { ...record, project: 'empty', revision: 1, details: { channel: 'empty', text: 'temporary' } });
    assert.ok(changed.eventId);
    await post('/api/mock-events', { ...record, project: 'empty', revision: 2, operation: 'delete', details: null });
    await handle(message('11', '!목표생성 empty | Waiting goal | Draft'));
    const waiting = (await app.inject('/api/goals')).json().find((g: any) => g.project === 'empty');
    await handle(message('12', `!계획 ${waiting.id}`)); assert.match(replies.at(-1)!, /근거가 없어/);
    assert.equal((await app.inject(`/api/goals/${waiting.id}`)).json().goal.current_plan, 0);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
