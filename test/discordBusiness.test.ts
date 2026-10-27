import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildServer } from '../src/server.js';
import { createService } from '../src/core.js';
import type { WorkflowStep } from '../src/workflow.js';
import { createDiscordBusinessBridge, createDiscordChat, createDiscordOwnerContextLoader, createContextualDiscordAnswer, createOpenAIAnswer, createClaimStore } from '../src/discordChat.js';
import { DISCORD_BUSINESS_SCOPE as scope } from '../src/discordScope.js';

test('Discord owner command reaches exact stored approval through authenticated bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-business-')); const dbPath = join(dir, 'test.sqlite');
  const token = 'x'.repeat(40);
  let app = buildServer({ dbPath, discordBridge: { ...scope, token } });
  const post = async (url: string, payload: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url, payload });
    assert.equal(res.statusCode, 200, res.body); return res.json();
  };
  try {
    const event = await post('/api/mock-events', { source: 'outlook', account: 'mock:primary', project: 'bridge-project', externalId: 'thread', revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert', details: { subject: 'Request', body: 'Review this request.' } });
    await post('/api/mock-events', { source: 'outlook', account: 'mock:other', project: 'other-project', externalId: 'private-thread', revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert', details: { subject: 'Other', body: 'Other project.' } });
    const goal = await post('/api/goals', { project: 'bridge-project', title: 'Review request', completion: 'Prepare draft' });
    assert.ok((await app.inject('/api/projects')).json().some((p: any) => p.project === 'bridge-project'));
    const targets = (await app.inject(`/api/goals/${goal.id}/targets`)).json();
    assert.equal(targets.length, 1);
    assert.equal(targets[0].eventId, event.eventId);
    await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    await post(`/api/goals/${goal.id}/step`, { version: 1 });
    await post(`/api/goals/${goal.id}/step`, { version: 1 });
    const detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    const approval = await post(`/api/goals/${goal.id}/approvals`, { artifactId: detail.artifacts[0].id, targetEventId: event.eventId });
    const request = { action: 'approve', goalId: goal.id, approvalId: approval.id, authorId: scope.ownerId, guildId: scope.guildId, channelId: scope.channelId };
    assert.equal((await app.inject({ method: 'POST', url: '/api/discord/business', payload: request })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/discord/business', headers: { 'x-work-assistant-discord-bridge': token }, payload: { ...request, authorId: '100000000000000005' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/discord/business', headers: { 'x-work-assistant-discord-bridge': token }, payload: { ...request, channelId: '100000000000000005' } })).statusCode, 403);
    const sent: string[] = []; const claims = new Set<string>(); let answerCalls = 0, bridgeCalls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      bridgeCalls++;
      const response = await app.inject({ method: 'POST', url: '/api/discord/business', headers: init?.headers as Record<string, string>, payload: init?.body as string });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    };
    const activatedAt = Date.now();
    const handle = createDiscordChat({ guildId: scope.guildId, channelId: scope.channelId, claim: id => !claims.has(id) && !!claims.add(id), business: { ownerId: scope.ownerId, activatedAt, run: createDiscordBusinessBridge('http://127.0.0.1:4317/api/discord/business', token, fetcher) }, answer: async () => { answerCalls++; return '일반 대화'; }, send: async text => { sent.push(text); } });
    const message = (id: string, userId: string, text: string) => ({ id, userId, text, guildId: scope.guildId, channelId: scope.channelId, bot: false, webhook: false, mentioned: false, origin: 'gateway' as const, createdTimestamp: activatedAt + 1 });
    await handle(message('1', '100000000000000005', `!승인 ${goal.id} ${approval.id}`));
    assert.equal(bridgeCalls, 0);
    await handle(message('2', scope.ownerId, `승인해줘 ${approval.id}`));
    assert.equal(answerCalls, 1);
    assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().outcomes.length, 0);
    await handle(message('3', scope.ownerId, `!승인목록 ${goal.id}`));
    assert.ok(sent.some(text => text.includes(approval.id) && text.includes('목업 내용')));
    const priorCalls = bridgeCalls;
    await handle({ ...message('historical-approval', scope.ownerId, `!승인 ${goal.id} ${approval.id}`), origin: 'catchup' });
    await handle({ ...message('historical-reject', scope.ownerId, `!거절 ${goal.id} ${approval.id}`), origin: 'catchup' });
    await handle({ ...message('old-gateway', scope.ownerId, `!승인 ${goal.id} ${approval.id}`), createdTimestamp: activatedAt - 1 });
    assert.equal(bridgeCalls, priorCalls);
    assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().outcomes.length, 0);
    assert.ok(sent.some(text => text.includes('새 메시지')));
    await handle({ ...message('historical-list', scope.ownerId, `!승인목록 ${goal.id}`), origin: 'catchup' });
    assert.equal(bridgeCalls, priorCalls + 1);
    await handle({ ...message('old-defer', scope.ownerId, `!보류 ${goal.id} ${approval.id}`), origin: 'catchup' });
    assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().approvals[0].status, 'pending');
    await handle(message('defer', scope.ownerId, `!보류 ${goal.id} ${approval.id}`));
    await handle(message('deferred-approval', scope.ownerId, `!승인 ${goal.id} ${approval.id}`));
    assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().approvals[0].status, 'deferred');
    assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().outcomes.length, 0);
    await handle(message('resume', scope.ownerId, `!재개 ${goal.id} ${approval.id}`));
    await handle(message('4', scope.ownerId, `!승인 ${goal.id} ${approval.id}`));
    await handle(message('5', scope.ownerId, `!승인 ${goal.id} ${approval.id}`));
    const final = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(final.outcomes.length, 1);
    assert.equal(final.approvals[0].reviewer, `discord:${scope.ownerId}`);
    assert.ok(sent.some(text => text.includes('already_executed')));
    await app.close(); app = buildServer({ dbPath, discordBridge: { ...scope, token } });
    assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().outcomes.length, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unconfigured bridge and unapproved channel fail closed', async () => {
  const app = buildServer({ dbPath: ':memory:' });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/discord/business', payload: { action: 'goals', authorId: scope.ownerId, guildId: scope.guildId, channelId: scope.channelId } });
    assert.equal(response.statusCode, 403);
    assert.throws(() => createDiscordBusinessBridge('http://127.0.0.1:4328/api/discord/business', 'x'.repeat(40)), /invalid_business_endpoint/);
  } finally { await app.close(); }
});

test('Discord default context excludes superseded drafts and preserves current provenance and history', () => {
  const service = createService({ dbPath: ':memory:' });
  const plan = (source: string, content: string): WorkflowStep[] => [
    { id: 'fact', tool: 'record_fact', dependsOn: [], input: { key: 'k', value: content, source, observedAt: '2026-10-27T09:00:00Z' } },
    { id: 'draft', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content, factStepId: 'fact' } }
  ];
  try {
    for (const project of ['alpha-current', 'beta-current']) service.mockConnectors.ingest({ source: 'teams', account: 'mock:primary', project, externalId: 'request', revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert', details: { channel: project, text: 'synthetic evidence' } });
    const alpha = service.createWorkspaceGoal({ project: 'alpha-current', title: 'Alpha', completion: 'Wait for a future item and prepare a draft' });
    const beta = service.createWorkspaceGoal({ project: 'beta-current', title: 'Beta', completion: 'Review' });
    const run = (id: string, version: number) => { service.workflow.runNext(id, version); service.workflow.runNext(id, version); };
    service.workflow.savePlan(alpha.id, 0, plan('old-source', 'WRONG: still waiting')); run(alpha.id, 1);
    service.workflow.savePlan(beta.id, 0, plan('beta-source', 'other goal draft')); run(beta.id, 1);
    service.workflow.savePlan(alpha.id, 1, plan('current-source', 'Correct: item received'));
    const getAlpha = () => service.discordWorkspaceContext().goals.find(g => g.id === alpha.id)!;
    assert.deepEqual(getAlpha().artifacts, []);
    run(alpha.id, 2);
    const current = getAlpha();
    assert.equal(current.current_plan, 2);
    assert.deepEqual(current.artifacts.map(a => ({ content: a.content, plan_version: a.plan_version, source: a.source, observed_at: a.observed_at })), [{ content: 'Correct: item received', plan_version: 2, source: 'current-source', observed_at: '2026-10-27T09:00:00Z' }]);
    assert.ok(current.steps.every(step => step.status === 'complete'));
    assert.deepEqual((service.inspectWorkspaceGoal(alpha.id).artifacts as any[]).map(a => a.content), ['WRONG: still waiting', 'Correct: item received']);
    assert.equal(service.discordWorkspaceContext().goals.find(g => g.id === beta.id)!.artifacts[0].content, 'other goal draft');
  } finally { service.close(); }
});

test('ordinary owner conversation receives current multi-goal context; another user receives none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-context-')); const dbPath = join(dir, 'test.sqlite'); const token = 'x'.repeat(40);
  let app = buildServer({ dbPath, discordBridge: { ...scope, token } });
  const post = async (url: string, payload: Record<string, unknown>) => { const response = await app.inject({ method: 'POST', url, payload }); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  let fetches = 0; const contexts: any[] = [];
  const fetcher: typeof fetch = async (_url, init) => { fetches++; const r = await app.inject({ method: 'POST', url: '/api/discord/business', headers: init?.headers as Record<string, string>, payload: init?.body as string }); return new Response(r.body, { status: r.statusCode, headers: { 'content-type': 'application/json' } }); };
  const loader = createDiscordOwnerContextLoader('http://127.0.0.1:4317/api/discord/business', token, fetcher);
  const answer = createContextualDiscordAnswer(loader, async (question, _history, context) => { contexts.push({ question, context }); return '답'; });
  const handled = new Set<string>();
  const handle = createDiscordChat({ guildId: scope.guildId, channelId: scope.channelId, claim: id => !handled.has(id) && !!handled.add(id), answer, send: async () => {} });
  const message = (id: string, userId: string) => ({ id, userId, text: '현재 상태?', guildId: scope.guildId, channelId: scope.channelId, bot: false, webhook: false, mentioned: false, origin: 'gateway' as const });
  try {
    for (const project of ['alpha', 'beta']) await post('/api/mock-events', { source: 'teams', account: 'mock:primary', project, externalId: `${project}-1`, revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: project, text: `${project} evidence` } });
    const alpha = await post('/api/goals', { project: 'alpha', title: 'Alpha work', completion: 'Draft' });
    await post('/api/goals', { project: 'beta', title: 'Beta work', completion: 'Review' });
    await post(`/api/goals/${alpha.id}/plan`, { expectedVersion: 0 });
    await post(`/api/goals/${alpha.id}/step`, { version: 1 }); await post(`/api/goals/${alpha.id}/step`, { version: 1 });
    await handle(message('1', '100000000000000005'));
    assert.equal(contexts[0].context, null); assert.equal(fetches, 0);
    await handle(message('2', scope.ownerId));
    assert.equal(fetches, 1); assert.equal(contexts[1].context.totalGoals, 2);
    assert.deepEqual(contexts[1].context.goals.map((g: any) => g.title).sort(), ['Alpha work', 'Beta work']);
    const found = contexts[1].context.goals.find((g: any) => g.id === alpha.id);
    assert.equal(found.steps.length, 2); assert.equal(found.artifacts.length, 1); assert.equal(found.sources[0].source, 'teams'); assert.ok(found.sources[0].reference);
    await app.close(); app = buildServer({ dbPath, discordBridge: { ...scope, token } });
    await handle(message('3', scope.ownerId)); assert.equal(contexts[2].context.totalGoals, 2);
    const denied = await app.inject({ method: 'POST', url: '/api/discord/business', payload: { action: 'context', authorId: scope.ownerId, guildId: scope.guildId, channelId: scope.channelId } });
    assert.equal(denied.statusCode, 403);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('populated mock goals and restored conversation use the SDK Responses message format', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-model-history-'));
  const token = 'bridge-synthetic-value-1234567890-abcd';
  const app = buildServer({ dbPath: join(dir, 'app.sqlite'), discordBridge: { ...scope, token } });
  const store = createClaimStore(join(dir, 'seen.sqlite'));
  const post = async (url: string, payload: object) => { const r = await app.inject({ method: 'POST', url, payload }); assert.equal(r.statusCode, 200); return r.json(); };
  const message = { id: 'synthetic-new', guildId: scope.guildId, channelId: scope.channelId, userId: scope.ownerId, bot: false, webhook: false, mentioned: false, text: 'Status?', origin: 'gateway' as const };
  const converter = createRequire(import.meta.url)('../node_modules/@openai/agents-openai/dist/openaiResponsesConverter.js');
  try {
    const project = 'SYNTHETIC-acceptance-example-proposal';
    for (const [source, externalId, details] of [
      ['teams', 'request', { channel: 'synthetic-proposal', text: 'SYNTHETIC: prepare proposal; vendor quote is still missing.' }],
      ['confluence', 'policy', { pageId: 'synthetic-policy', title: 'SYNTHETIC proposal policy', body: 'Draft locally and wait for the vendor quote.' }],
      ['outlook', 'planning-note', { subject: 'SYNTHETIC planning note', body: 'The vendor quote is not yet available.' }]
    ] as const) await post('/api/mock-events', { source, account: 'mock:acceptance', project, externalId, revision: 1, occurredAt: '2026-10-27T09:00:00.000Z', operation: 'upsert', details });
    const goal = await post('/api/goals', { project, title: '[SYNTHETIC example] Proposal review', completion: 'Create a local draft and wait for vendor quote.' });
    await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    await post(`/api/goals/${goal.id}/step`, { version: 1 }); await post(`/api/goals/${goal.id}/step`, { version: 1 });
    store.save({ ...message, id: 'synthetic-old' }, 'Hello', 'Previous answer');
    assert.throws(() => converter.getInputItems([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Previous answer' }]));
    const fetcher: typeof fetch = async (_url, init) => { const r = await app.inject({ method: 'POST', url: '/api/discord/business', headers: init?.headers as Record<string, string>, payload: init?.body as string }); return new Response(r.body, { status: r.statusCode }); };
    const loader = createDiscordOwnerContextLoader('http://127.0.0.1:4317/api/discord/business', token, fetcher);
    let calls = 0; const sent: string[] = []; const stages: string[] = [];
    const answer = createOpenAIAnswer('synthetic-api-key', loader, [token], async items => {
      calls++;
      const wire = converter.getInputItems(items);
      assert.equal(wire[1].role, 'assistant'); assert.equal(wire[1].content[0].text, 'Previous answer');
      assert.match(JSON.stringify(wire[2]), /SYNTHETIC-acceptance-example-proposal/);
      assert.match(JSON.stringify(wire[2]), /vendor quote/);
      return 'Current mock status';
    });
    const handle = createDiscordChat({ guildId: scope.guildId, channelId: scope.channelId, claim: id => store.claim(id), history: store, answer, send: async text => { sent.push(text); }, onFailureStage: stage => { stages.push(stage); } });
    await handle(message);
    assert.equal(calls, 1); assert.deepEqual(sent, ['Current mock status']); assert.deepEqual(stages, []);
    assert.deepEqual(store.load(message).map(x => x.content), ['Hello', 'Previous answer', 'Status?', 'Current mock status']);
  } finally { store.close(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
