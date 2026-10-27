import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { Db } from '../src/db.js';
import { createModelPlannerAdapter } from '../src/modelPlanner.js';
import { createDiscordBusinessBridge } from '../src/discordChat.js';
import { DISCORD_BUSINESS_SCOPE as scope } from '../src/discordScope.js';
import { createService } from '../src/core.js';
import { createDurableScheduler } from '../src/durableScheduler.js';

test('static attempt diagnostics survive restart, isolate goals, redact unknown failures and reach Discord once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-diagnostic-')), dbPath = join(dir, 'test.sqlite');
  const token = 'x'.repeat(40), sensitive = 'private-error-example'; let mode = 'known', calls = 0;
  const model = createModelPlannerAdapter(async () => {
    calls++;
    return { steps: [{ id: 'fact', dependsOn: [], tool: 'record_fact', input: { key: 'unavailable-key' } }] };
  });
  const opts = { dbPath, discordBridge: { ...scope, token }, plannerAdapterFactory: () => async (input: Parameters<typeof model>[0]) => {
    if (mode === 'unknown') { calls++; throw new Error(sensitive); }
    if (mode === 'spoof') { calls++; throw new Error('fact_not_verified'); }
    return model(input);
  } };
  let app = buildServer(opts);
  const post = (url: string, payload: object, headers?: Record<string, string>) => app.inject({ method: 'POST', url, payload, headers });
  try {
    for (const project of ['alpha', 'beta']) await post('/api/mock-events', { source: 'teams', account: 'mock:primary', project, externalId: 'event', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: project, text: 'Synthetic source' } });
    const goal = (await post('/api/goals', { project: 'alpha', title: 'Review', completion: 'Draft' })).json();
    const other = (await post('/api/goals', { project: 'beta', title: 'Other', completion: 'Draft' })).json();
    const known = await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    assert.equal(known.statusCode, 422); assert.equal(known.json().code, 'fact_not_verified');
    assert.equal(known.json().attemptId, 1);
    mode = 'unknown';
    const unknown = await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    assert.equal(unknown.json().code, 'planner_unknown_failure');
    assert.doesNotMatch(unknown.body, new RegExp(sensitive));
    mode = 'spoof';
    assert.equal((await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 })).json().code, 'planner_unknown_failure');
    mode = 'unknown';
    assert.equal((await app.inject(`/api/goals/${other.id}`)).json().plannerAttempts.length, 0);
    const bridgeBody = { action: 'plan_goal', messageId: '100000000000000010', goalId: goal.id, authorId: scope.ownerId, guildId: scope.guildId, channelId: scope.channelId };
    const headers = { 'x-work-assistant-discord-bridge': token };
    const bridgeResult = await post('/api/discord/business', bridgeBody, headers);
    assert.equal(bridgeResult.json().status, 'plan_failed'); assert.equal(bridgeResult.json().code, 'planner_unknown_failure');
    const repeated = await post('/api/discord/business', bridgeBody, headers);
    assert.deepEqual(repeated.json(), bridgeResult.json()); assert.equal(calls, 4);
    const fetcher: typeof fetch = async () => new Response(bridgeResult.body, { status: 200 });
    const bridge = createDiscordBusinessBridge('http://127.0.0.1:4317/api/discord/business', token, fetcher);
    const reply = await bridge({ action: 'plan_goal', goalId: goal.id }, { id: bridgeBody.messageId, guildId: scope.guildId, channelId: scope.channelId, userId: scope.ownerId, bot: false, webhook: false, mentioned: false, text: '', origin: 'gateway' });
    assert.match(reply, /planner_unknown_failure/); assert.doesNotMatch(reply, new RegExp(sensitive));
    await app.close(); app = buildServer(opts);
    const attempts = (await app.inject(`/api/goals/${goal.id}`)).json().plannerAttempts;
    assert.deepEqual(attempts.map((a: any) => a.code), ['planner_unknown_failure', 'planner_unknown_failure', 'planner_unknown_failure', 'fact_not_verified']);
    assert.ok(attempts.every((a: any) => a.status === 'failed'));
    assert.doesNotMatch(JSON.stringify(attempts), new RegExp(sensitive));
    const db = new Db(dbPath);
    try {
      const policy = db.get<{ version: number }>('SELECT max(version) AS version FROM workflow_planner_policies WHERE goal_id=?', [goal.id])!;
      db.run("INSERT INTO workflow_planner_attempts(goal_id,policy_version,status,created_at) VALUES(?,?,'failed',?)", [goal.id, policy.version, '2026-10-27T00:00:00Z']);
      assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().plannerAttempts[0].code, null);
      assert.doesNotMatch(JSON.stringify(db.all('SELECT * FROM workflow_planner_diagnostics')), new RegExp(sensitive));
    } finally { db.close(); }
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a late adapter cannot overwrite the diagnostic saved by an expired scheduler lease', async () => {
  const service = createService({ dbPath: ':memory:' });
  let time = 1000, release!: () => void, entered!: () => void, caught: unknown;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  try {
    service.workflow.createGoal({ id: 'lease-goal', title: 'Review', owner: 'local', completion: 'Draft' });
    service.workflow.configurePlanner('lease-goal', 0, { allowedSources: [], trustedFacts: [], allowedArtifactKinds: ['draft'], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 1000, maxPlanVersions: 3, maxPlannerAttempts: 2 });
    const scheduler = createDurableScheduler(service.db, { now: () => time, leaseMs: 100, retryBaseMs: 10, maxPerTick: 1 });
    scheduler.enqueue({ goalId: 'lease-goal', eventId: 'e1', kind: 'event', payload: {}, semantics: 'local_idempotent', dueAt: time });
    const first = scheduler.tick(async ctx => {
      try { await service.workflow.planWithAdapter('lease-goal', 0, async () => { entered(); await gate; throw new Error('late-sensitive-error'); }, 5000, { schedulerLease: { jobId: ctx.jobId, runId: ctx.runId, leaseToken: ctx.leaseToken } }); }
      catch (error) { caught = error; }
      return { outcome: 'no_progress' };
    });
    await ready; time += 101;
    await scheduler.tick(async () => ({ outcome: 'progress' }));
    release(); await first;
    assert.equal((caught as Error).message, 'planner_attempt_fenced');
    assert.equal(service.workflow.inspect('lease-goal').plannerAttempts[0].code, 'planner_attempt_fenced');
    assert.equal(service.workflow.inspect('lease-goal').plans.length, 0);
  } finally { release(); service.close(); }
});
