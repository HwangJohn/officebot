import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { createModelPlannerAdapter } from '../src/modelPlanner.js';
import { Db } from '../src/db.js';

test('model planner serves distinct API goals from scoped facts and rejects malformed and over-budget plans', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-planner-')); const dbPath = join(dir, 'test.sqlite');
  const prompts: any[] = []; let mode = 'valid';
  const adapter = createModelPlannerAdapter(async prompt => {
    const context = JSON.parse(prompt.split('\n').at(-1)!); prompts.push(context);
    if (mode === 'malformed') return { steps: [{ tool: 'execute_shell' }] };
    if (mode === 'forged') return { steps: [{ id: 'fact', dependsOn: [], tool: 'record_fact', input: { key: 'invented' } }] };
    if (mode === 'over') return { steps: Array.from({ length: 9 }, (_, i) => ({ id: `fact${i}`, dependsOn: [], tool: 'record_fact', input: { key: context.facts[0].key } })) };
    const facts = context.goal.title === 'weekly' ? context.facts.slice(0, 2) : context.facts.slice(0, 1);
    return { steps: facts.flatMap((fact: any, i: number) => [
      { id: `fact${i}`, dependsOn: [], tool: 'record_fact', input: { key: fact.key } },
      { id: `draft${i}`, dependsOn: [`fact${i}`], tool: 'create_artifact', input: { kind: 'draft', content: `${context.goal.title}: ${fact.value}`, factStepId: `fact${i}` } }
    ]) };
  });
  const app = buildServer({ dbPath, plannerAdapterFactory: () => adapter });
  const post = async (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload });
  try {
    for (const [project, externalId, text] of [['alpha', 'a1', 'alpha one'], ['alpha', 'a2', 'alpha two'], ['beta', 'b1', 'beta evidence']]) {
      assert.equal((await post('/api/mock-events', { source: 'teams', account: 'mock:primary', project, externalId, revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: project, text } })).statusCode, 200);
    }
    const a = (await post('/api/goals', { project: 'alpha', title: 'weekly', completion: 'review all' })).json();
    const b = (await post('/api/goals', { project: 'beta', title: 'proposal', completion: 'draft' })).json();
    assert.equal((await post(`/api/goals/${a.id}/plan`, { expectedVersion: 0 })).statusCode, 200);
    assert.equal((await post(`/api/goals/${b.id}/plan`, { expectedVersion: 0 })).statusCode, 200);
    assert.equal(prompts[0].facts.length, 2); assert.equal(prompts[1].facts.length, 1);
    assert.doesNotMatch(JSON.stringify(prompts[1]), /alpha one|alpha two/);
    assert.equal((await app.inject(`/api/goals/${a.id}`)).json().steps.length, 4);
    assert.equal((await app.inject(`/api/goals/${b.id}`)).json().steps.length, 2);
    for (const goal of [a, b]) {
      const count = goal.id === a.id ? 4 : 2;
      for (let i = 0; i < count; i++) assert.equal((await post(`/api/goals/${goal.id}/step`, { version: 1 })).statusCode, 200);
    }
    assert.equal((await app.inject(`/api/goals/${a.id}`)).json().artifacts.length, 2);
    for (mode of ['malformed', 'forged', 'over']) {
      assert.notEqual((await post(`/api/goals/${b.id}/plan`, { expectedVersion: 1 })).statusCode, 200);
      assert.equal((await app.inject(`/api/goals/${b.id}`)).json().plans.length, 1);
    }
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('planner timeout aborts an uncooperative transport, consumes budget and ignores late output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-timeout-')); const dbPath = join(dir, 'test.sqlite');
  let signal!: AbortSignal; let finish!: (value: unknown) => void;
  const adapter = createModelPlannerAdapter(async (_prompt, s) => { signal = s; return new Promise(resolve => { finish = resolve; }); });
  const app = buildServer({ dbPath, plannerAdapterFactory: () => adapter, plannerTimeoutMs: 25 });
  const post = async (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload });
  try {
    await post('/api/mock-events', { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'a', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'alpha', text: 'evidence' } });
    const goal = (await post('/api/goals', { project: 'alpha', title: 'timeout', completion: 'review' })).json();
    const result = await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    assert.notEqual(result.statusCode, 200); assert.equal(signal.aborted, true);
    finish({ steps: [] }); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().plans.length, 0);
    const db = new Db(dbPath);
    assert.equal(db.get<{ status: string }>('SELECT status FROM workflow_planner_attempts WHERE goal_id=?', [goal.id])?.status, 'failed');
    db.close();
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('planner refuses detected sensitive input before making a model request', async () => {
  const secret = 'example-sensitive-value'; let sent = '';
  const adapter = createModelPlannerAdapter(async prompt => {
    sent = prompt;
    return { steps: [{ id: 'fact', dependsOn: [], tool: 'record_fact', input: { key: 'evidence:1' } }] };
  }, [secret]);
  const fact = { key: 'evidence:1', value: `text ${secret}`, source: 'mock:1', observedAt: '2026-10-27T00:00:00Z' };
  await assert.rejects(adapter({ goal: { id: 'g', title: 'title', completion: 'done' }, facts: [fact], memory: { preferences: [], conversation: [] }, personalTasks: [], allowedArtifactKinds: ['draft'], maxSteps: 8, signal: new AbortController().signal }), /planner_sensitive_input/);
  assert.equal(sent, '');
});

test('model dependency repair only adds a prior verified fact prerequisite', async () => {
  let mode = 'missing-edge';
  const adapter = createModelPlannerAdapter(async prompt => {
    const context = JSON.parse(prompt.split('\n').at(-1)!);
    const fact = { id: 'fact', tool: 'record_fact', dependsOn: [], input: { key: context.facts[0].key } };
    const draft = { id: 'draft', tool: 'create_artifact', dependsOn: [], input: { kind: 'draft', content: 'review', factStepId: mode === 'unknown' ? 'invented' : mode === 'not-fact' ? 'middle' : 'fact' } };
    if (mode === 'forward') return { steps: [draft, fact] };
    if (mode === 'not-fact') return { steps: [fact, { id: 'middle', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content: 'middle', factStepId: 'fact' } }, draft] };
    return { steps: [fact, draft] };
  });
  const app = buildServer({ dbPath: ':memory:', plannerAdapterFactory: () => adapter });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  try {
    await post('/api/mock-events', { source: 'teams', account: 'mock:primary', project: 'repair', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'repair', text: 'verified evidence' } });
    const goal = (await post('/api/goals', { project: 'repair', title: 'Review', completion: 'Draft' })).json();
    assert.equal((await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 })).statusCode, 200);
    const stored = (await app.inject(`/api/goals/${goal.id}`)).json().steps;
    assert.deepEqual(JSON.parse(stored[1].depends_json), ['fact']);
    assert.equal((await post(`/api/goals/${goal.id}/step`, { version: 1 })).statusCode, 200);
    assert.equal((await post(`/api/goals/${goal.id}/step`, { version: 1 })).statusCode, 200);
    for (mode of ['unknown', 'not-fact', 'forward']) {
      assert.notEqual((await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 1 })).statusCode, 200);
      assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().plans.length, 1);
    }
    const input = { goal: { id: 'g', title: 'Review', completion: 'Draft' }, facts: [{ key: 'evidence:1', source: 'teams:1', value: 'verified', observedAt: '2026-10-27T00:00:00Z' }], memory: { preferences: [], conversation: [] }, personalTasks: [], allowedArtifactKinds: ['draft'], maxSteps: 8, signal: new AbortController().signal };
    for (const [scenario, code] of [['unknown', 'invalid_artifact_unknown_fact_step'], ['not-fact', 'invalid_artifact_non_fact_step'], ['forward', 'invalid_artifact_future_fact_step']] as const) {
      mode = scenario;
      await assert.rejects(adapter(input), error => error instanceof Error && error.message === code);
    }
  } finally { await app.close(); }
});

test('planner receives scoped current record identities and reuses a same-purpose open task after correction', async () => {
  const contexts: any[] = [];
  const adapter = createModelPlannerAdapter(async prompt => {
    assert.match(prompt, /usable local draft itself/);
    assert.match(prompt, /Reuse the taskKey of an open task/);
    const ctx = JSON.parse(prompt.split('\n').at(-1)!); contexts.push(ctx);
    const record = ctx.currentRecords.records.find((r: any) => r.source === 'outlook' && r.account === 'mock:acceptance' && r.externalId === 'quote');
    const fact = record?.factKey ? ctx.facts.find((f: any) => f.key === record.factKey) : ctx.facts[0];
    return { steps: [
      { id: 'fact', tool: 'record_fact', dependsOn: [], input: { key: fact.key } },
      { id: 'draft', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content: record ? `Draft: ${fact.value}` : 'Draft pending quote', factStepId: 'fact' } },
      { id: 'task', tool: 'personal_followup', dependsOn: ['fact'], input: { taskKey: ctx.personalTasks.find((t: any) => t.status === 'open')?.taskKey ?? 'review', title: 'Review draft', factStepId: 'fact' } },
      ...(!record ? [{ id: 'wait', tool: 'wait_for_mock_record', dependsOn: [], input: { source: 'outlook', account: 'mock:acceptance', externalId: 'quote' } }] : [])
    ] };
  });
  const app = buildServer({ dbPath: ':memory:', plannerAdapterFactory: () => adapter });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const event = (project: string, source: string, externalId: string, revision: number, details: object | null, operation = 'upsert') => ({ source, account: 'mock:acceptance', project, externalId, revision, occurredAt: `2026-10-27T0${revision}:00:00Z`, operation, details });
  try {
    await post('/api/mock-events', event('own', 'teams', 'request', 1, { channel: 'own', text: 'Old deadline' }));
    await post('/api/mock-events', event('other', 'outlook', 'quote', 1, { subject: 'Other', body: 'private' }));
    await post('/api/mock-events', { ...event('own', 'outlook', 'quote', 1, { subject: 'Other account', body: 'different account' }), account: 'mock:other' });
    const goal = (await post('/api/goals', { project: 'own', title: 'Review', completion: 'Draft and wait' })).json();
    assert.equal((await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 })).statusCode, 200);
    assert.equal(contexts[0].currentRecords.records.some((r: any) => r.externalId === 'quote' && r.account === 'mock:acceptance'), false);
    assert.equal(contexts[0].currentRecords.records.some((r: any) => r.externalId === 'quote' && r.account === 'mock:other'), true);
    for (let i = 0; i < 3; i++) assert.equal((await post(`/api/goals/${goal.id}/step`, { version: 1 })).statusCode, 200);
    await post('/api/mock-events', event('own', 'teams', 'request', 2, { channel: 'own', text: 'Corrected deadline' }));
    await post('/api/mock-events', event('own', 'outlook', 'quote', 1, { subject: 'Quote', body: 'Corrected deadline and 12 units' }));
    assert.equal((await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 1 })).statusCode, 200);
    const record = contexts[1].currentRecords.records.find((r: any) => r.externalId === 'quote' && r.account === 'mock:acceptance');
    assert.equal(record.account, 'mock:acceptance'); assert.equal(record.source, 'outlook'); assert.equal(record.revision, 1);
    assert.ok(contexts[1].facts.some((f: any) => f.key === record.factKey && f.value.includes('12 units')));
    assert.doesNotMatch(JSON.stringify(contexts[1]), /private/);
    for (let i = 0; i < 3; i++) assert.equal((await post(`/api/goals/${goal.id}/step`, { version: 2 })).statusCode, 200);
    const detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.personalTasks.length, 1); assert.match(detail.artifacts.at(-1).content, /Corrected deadline and 12 units/);
    assert.equal((await post('/api/mock-events', event('own', 'outlook', 'quote', 2, null, 'delete'))).statusCode, 200);
    assert.equal((await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 2 })).statusCode, 200);
    assert.equal(contexts[2].currentRecords.records.some((r: any) => r.externalId === 'quote' && r.account === 'mock:acceptance'), false);
    assert.equal(contexts[2].currentRecords.records.some((r: any) => r.externalId === 'quote' && r.account === 'mock:other'), true);
  } finally { await app.close(); }
});

test('a newly arrived scoped record fences an in-flight planner snapshot', async () => {
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>(r => { started = r; });
  const adapter = createModelPlannerAdapter(async prompt => { const ctx = JSON.parse(prompt.split('\n').at(-1)!); started(); await new Promise<void>(r => { release = r; }); return { steps: [{ id: 'fact', tool: 'record_fact', dependsOn: [], input: { key: ctx.facts[0].key } }] }; });
  const app = buildServer({ dbPath: ':memory:', plannerAdapterFactory: () => adapter });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const ev = (id: string) => ({ source: 'teams', account: 'mock:acceptance', project: 'own', externalId: id, revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'own', text: id } });
  try {
    await post('/api/mock-events', ev('first'));
    const goal = (await post('/api/goals', { project: 'own', title: 'Review', completion: 'Draft' })).json();
    const pending = post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    await entered; await post('/api/mock-events', ev('new')); release();
    assert.notEqual((await pending).statusCode, 200);
    assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().plans.length, 0);
  } finally { await app.close(); }
});
