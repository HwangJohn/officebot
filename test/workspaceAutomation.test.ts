import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { Db } from '../src/db.js';
import type { PlannerAdapter } from '../src/workflow.js';
import { createDurableScheduler } from '../src/durableScheduler.js';
import { createWorkspaceAutomation } from '../src/workspaceAutomation.js';

const DAY = 86_400_000;
test('workspace event wakeups and scoped review schedules survive restart without duplicate effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-automation-')); const dbPath = join(dir, 'test.sqlite');
  let time = Date.UTC(2026, 9, 27);
  let app = buildServer({ dbPath, schedulerClock: () => time });
  const post = async (url: string, payload: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: 'POST', url, payload });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`); return response.json();
  };
  const event = { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'alpha', text: 'Alpha original' } };
  try {
    await post('/api/mock-events', event);
    await post('/api/mock-events', { ...event, project: 'beta', details: { channel: 'beta', text: 'Beta evidence' } });
    const alpha = await post('/api/goals', { project: 'alpha', title: 'Alpha work', completion: 'Review' });
    const beta = await post('/api/goals', { project: 'beta', title: 'Beta work', completion: 'Review' });
    await post(`/api/goals/${alpha.id}/schedules`, { kind: 'daily_review', firstDueAt: time + DAY });
    await post(`/api/goals/${alpha.id}/schedules`, { kind: 'weekly_review', firstDueAt: time + 7 * DAY });
    await post(`/api/goals/${beta.id}/schedules`, { kind: 'daily_review', firstDueAt: time + DAY });
    const updated = { ...event, revision: 3, details: { channel: 'alpha', text: 'Alpha revision' } };
    await post('/api/mock-events', updated);
    assert.equal((await post('/api/mock-events', updated)).inserted, false);
    await post('/api/mock-events', { ...event, revision: 2, details: { channel: 'alpha', text: 'Late old revision' } });
    assert.equal((await post('/api/scheduler/tick')).started, 1);
    let a = (await app.inject(`/api/goals/${alpha.id}`)).json();
    let b = (await app.inject(`/api/goals/${beta.id}`)).json();
    assert.equal(a.automation.activity.length, 1);
    assert.equal(b.automation.activity.length, 0);
    assert.equal(a.automation.activity[0].details.project, 'alpha');
    assert.equal((await post('/api/scheduler/tick')).started, 0);
    await app.close(); app = buildServer({ dbPath, schedulerClock: () => time });
    time += DAY;
    assert.equal((await post('/api/scheduler/tick')).started, 2);
    a = (await app.inject(`/api/goals/${alpha.id}`)).json();
    b = (await app.inject(`/api/goals/${beta.id}`)).json();
    assert.equal(a.automation.reviews.length, 1);
    assert.equal(b.automation.reviews.length, 1);
    assert.equal(a.automation.reviews[0].approval_status, 'no_action');
    assert.deepEqual(a.automation.reviews[0].artifact.proposals, []);
    assert.match(JSON.stringify(a.automation.reviews[0].artifact), /Alpha revision/);
    assert.doesNotMatch(JSON.stringify(a.automation.reviews[0].artifact), /Beta evidence|Alpha original/);
    assert.match(JSON.stringify(b.automation.reviews[0].artifact), /Beta evidence/);
    assert.equal((await post('/api/scheduler/tick')).started, 0);
    time += 6 * DAY;
    assert.equal((await post('/api/scheduler/tick')).started, 3);
    a = (await app.inject(`/api/goals/${alpha.id}`)).json();
    b = (await app.inject(`/api/goals/${beta.id}`)).json();
    assert.equal(a.automation.reviews.length, 3);
    assert.equal(b.automation.reviews.length, 2);
    assert.equal(a.automation.activity.length, 1);
    assert.equal(a.outcomes.length + b.outcomes.length, 0);
    assert.equal((await post('/api/scheduler/tick')).started, 0);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('reviews propose an action only for sourced blocked issues and stop without evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-reviews-')); const dbPath = join(dir, 'test.sqlite');
  const time = Date.UTC(2026, 9, 27);
  const app = buildServer({ dbPath, schedulerClock: () => time });
  const post = async (url: string, payload: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: 'POST', url, payload });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  try {
    const blocked = { source: 'jira', account: 'mock:primary', project: 'blocked', externalId: 'J-1', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { issueKey: 'J-1', status: 'blocked', summary: 'Waiting for review' } };
    await post('/api/mock-events', blocked);
    const goal = await post('/api/goals', { project: 'blocked', title: 'Blocked work', completion: 'Review' });
    await post(`/api/goals/${goal.id}/schedules`, { kind: 'daily_review', firstDueAt: time });
    await post('/api/scheduler/tick');
    const detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    const review = detail.automation.reviews[0];
    assert.equal(review.approval_status, 'human_review_required');
    assert.equal(review.artifact.proposals.length, 1);
    assert.ok(review.artifact.evidence.some((e: any) => e.reference === review.artifact.proposals[0].evidenceReferences[0]));
    const empty = { ...blocked, project: 'empty' };
    await post('/api/mock-events', empty);
    const emptyGoal = await post('/api/goals', { project: 'empty', title: 'No evidence', completion: 'Review' });
    await post('/api/mock-events', { ...empty, revision: 2, operation: 'delete', details: null });
    await post(`/api/goals/${emptyGoal.id}/schedules`, { kind: 'weekly_review', firstDueAt: time });
    await post('/api/scheduler/tick');
    const emptyDetail = (await app.inject(`/api/goals/${emptyGoal.id}`)).json();
    assert.equal(emptyDetail.automation.reviews.length, 0);
    assert.ok(emptyDetail.automation.jobs.some((j: any) => j.kind === 'weekly_review' && j.status === 'stopped'));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy healthy reviews migrate once without losing historical rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-review-migrate-')); const dbPath = join(dir, 'test.sqlite');
  const time = Date.UTC(2026, 9, 27);
  let app = buildServer({ dbPath, schedulerClock: () => time });
  try {
    const post = async (url: string, payload: Record<string, unknown>) => {
      const response = await app.inject({ method: 'POST', url, payload });
      assert.equal(response.statusCode, 200, response.body); return response.json();
    };
    await post('/api/mock-events', { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'alpha', text: 'Evidence' } });
    const goal = await post('/api/goals', { project: 'alpha', title: 'Alpha', completion: 'Review' });
    await post(`/api/goals/${goal.id}/schedules`, { kind: 'daily_review', firstDueAt: time });
    await post('/api/scheduler/tick', {});
    await app.close();
    const db = new Db(dbPath);
    db.run('INSERT INTO workspace_empty_reviews SELECT * FROM scheduler_reviews');
    db.run('DELETE FROM scheduler_reviews');
    db.close();
    app = buildServer({ dbPath, schedulerClock: () => time });
    let reviews = (await app.inject(`/api/goals/${goal.id}`)).json().automation.reviews;
    assert.equal(reviews.length, 1); assert.equal(reviews[0].approval_status, 'no_action');
    await app.close(); app = buildServer({ dbPath, schedulerClock: () => time });
    reviews = (await app.inject(`/api/goals/${goal.id}`)).json().automation.reviews;
    assert.equal(reviews.length, 1);
    const check = new Db(dbPath);
    assert.equal(check.get<{ n: number }>('SELECT COUNT(*) n FROM workspace_empty_reviews')?.n, 1);
    assert.equal(check.get<{ n: number }>('SELECT COUNT(*) n FROM scheduler_reviews')?.n, 1);
    check.close();
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy review migration rejects malformed evidence without altering either store', () => {
  const db = new Db(':memory:'); const now = () => Date.UTC(2026, 9, 27);
  try {
    db.run('INSERT INTO workflow_goals(id,title,owner,completion,created_at) VALUES(?,?,?,?,?)', ['g', 'g', 'local', 'done', '2026-10-27T00:00:00Z']);
    db.run('INSERT INTO workspace_goals(goal_id,owner) VALUES(?,?)', ['g', 'local']);
    const scheduler = createDurableScheduler(db, { now });
    const job = scheduler.enqueue({ goalId: 'g', eventId: 'review', dueAt: now(), kind: 'daily_review', payload: {}, semantics: 'local_idempotent' });
    db.run('INSERT INTO workspace_empty_reviews(job_id,goal_id,kind,artifact_json,approval_status,created_at) VALUES(?,?,?,?,?,?)', [job.jobId, 'g', 'daily_review', JSON.stringify({ summary: 'bad', evidence: [{}], proposals: [] }), 'no_action', now()]);
    assert.throws(() => createWorkspaceAutomation(db, scheduler, now), /legacy_review_invalid/);
    assert.equal(db.get<{ n: number }>('SELECT count(*) n FROM scheduler_reviews')?.n, 0);
    assert.equal(db.get<{ n: number }>('SELECT count(*) n FROM workspace_empty_reviews')?.n, 1);
  } finally { db.close(); }
});

test('an opted-in goal replans and executes after an event, with timeout recovery and no duplicate local work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-event-plan-')); const dbPath = join(dir, 'test.sqlite');
  let time = Date.UTC(2026, 9, 27); let hold = false; let cancelled: AbortSignal | undefined;
  let finish!: (value: unknown) => void;
  const proposal = (input: Parameters<PlannerAdapter>[0]) => ({ steps: [
    { id: 'fact', dependsOn: [], tool: 'record_fact', input: input.facts[0] },
    { id: 'draft', dependsOn: ['fact'], tool: 'create_artifact', input: { kind: 'draft', content: `Reviewed: ${input.facts[0].value}`, factStepId: 'fact' } }
  ] });
  const adapter: PlannerAdapter = input => {
    if (!hold) return Promise.resolve(proposal(input));
    cancelled = input.signal; return new Promise(resolve => { finish = resolve; });
  };
  const opts = { dbPath, schedulerClock: () => time, plannerAdapterFactory: () => adapter, plannerTimeoutMs: 1000, handlerTimeoutMs: 30 };
  let app = buildServer(opts);
  const post = async (url: string, payload: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: 'POST', url, payload }); assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const event = { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'alpha', text: 'original' } };
  try {
    await post('/api/mock-events', event);
    await post('/api/mock-events', { ...event, project: 'beta', details: { channel: 'beta', text: 'beta' } });
    const a = await post('/api/goals', { project: 'alpha', title: 'Plan alpha', completion: 'Review' });
    const b = await post('/api/goals', { project: 'beta', title: 'Plan beta', completion: 'Review' });
    await post(`/api/goals/${a.id}/plan`, { expectedVersion: 0 });
    await post('/api/mock-events', { ...event, revision: 2, details: { channel: 'alpha', text: 'new evidence' } });
    hold = true; await post('/api/scheduler/tick');
    assert.equal(cancelled?.aborted, true);
    let detail = (await app.inject(`/api/goals/${a.id}`)).json();
    assert.equal(detail.goal.current_plan, 1); assert.equal(detail.artifacts.length, 0);
    assert.equal(detail.automation.jobs.find((j: any) => j.kind === 'event').status, 'pending');
    finish({ steps: [] }); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await app.inject(`/api/goals/${a.id}`)).json().goal.current_plan, 1);
    await app.close(); hold = false; time += 1000; app = buildServer(opts);
    await post('/api/scheduler/tick');
    detail = (await app.inject(`/api/goals/${a.id}`)).json();
    assert.equal(detail.goal.current_plan, 2); assert.equal(detail.artifacts.length, 1);
    assert.match(detail.artifacts[0].content, /new evidence/);
    assert.equal(detail.automation.activity[0].kind, 'goal_replanned');
    assert.equal((await app.inject(`/api/goals/${b.id}`)).json().goal.current_plan, 0);
    await post('/api/scheduler/tick');
    assert.equal((await app.inject(`/api/goals/${a.id}`)).json().artifacts.length, 1);
    await app.close(); app = buildServer(opts);
    assert.equal((await app.inject(`/api/goals/${a.id}`)).json().artifacts.length, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('event execution resumes its saved plan after an interrupted local step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-event-resume-')); const dbPath = join(dir, 'test.sqlite');
  let time = Date.UTC(2026, 9, 27); const opts = { dbPath, schedulerClock: () => time };
  let app = buildServer(opts);
  const post = async (url: string, payload: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: 'POST', url, payload }); assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const event = { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'alpha', text: 'original' } };
  try {
    await post('/api/mock-events', event);
    const goal = await post('/api/goals', { project: 'alpha', title: 'Review', completion: 'Draft' });
    await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    await post('/api/mock-events', { ...event, revision: 2, details: { channel: 'alpha', text: 'updated' } });
    const db = new Db(dbPath);
    db.db.exec("CREATE TRIGGER injected_step_failure BEFORE INSERT ON workflow_facts BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    await post('/api/scheduler/tick');
    let detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.goal.current_plan, 2); assert.equal(detail.artifacts.length, 0);
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) n FROM workspace_event_plans WHERE goal_id=?', [goal.id])?.n, 1);
    db.db.exec('DROP TRIGGER injected_step_failure'); db.close();
    await app.close(); time += 1000; app = buildServer(opts);
    await post('/api/scheduler/tick');
    detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.goal.current_plan, 2); assert.equal(detail.artifacts.length, 1);
    assert.match(detail.artifacts[0].content, /updated/);
    await post('/api/scheduler/tick'); assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().artifacts.length, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a newer event fences an in-flight older event plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-event-race-')); const dbPath = join(dir, 'test.sqlite');
  let calls = 0, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const adapter: PlannerAdapter = async input => {
    calls++;
    if (calls === 2) { entered(); await gate; }
    return { steps: [
      { id: 'fact', dependsOn: [], tool: 'record_fact', input: input.facts[0] },
      { id: 'draft', dependsOn: ['fact'], tool: 'create_artifact', input: { kind: 'draft', content: input.facts[0].value, factStepId: 'fact' } }
    ] };
  };
  const app = buildServer({ dbPath, schedulerClock: () => Date.UTC(2026, 9, 27), plannerAdapterFactory: () => adapter });
  const post = async (url: string, payload: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: 'POST', url, payload }); assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const event = { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'alpha', text: 'original' } };
  try {
    await post('/api/mock-events', event);
    const goal = await post('/api/goals', { project: 'alpha', title: 'Review', completion: 'Draft' });
    await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    await post('/api/mock-events', { ...event, revision: 2, details: { channel: 'alpha', text: 'stale' } });
    const ticking = post('/api/scheduler/tick'); await started;
    await post('/api/mock-events', { ...event, revision: 3, details: { channel: 'alpha', text: 'latest' } });
    release(); await ticking;
    const detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.goal.current_plan, 2); assert.equal(detail.artifacts.length, 1);
    assert.match(detail.artifacts[0].content, /latest/); assert.doesNotMatch(detail.artifacts[0].content, /stale/);
  } finally { release(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an event that removes all evidence stops without futile replanning retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-no-evidence-')); const dbPath = join(dir, 'test.sqlite');
  const app = buildServer({ dbPath, schedulerClock: () => Date.UTC(2026, 9, 27) });
  const post = async (url: string, payload: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: 'POST', url, payload }); assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const event = { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'alpha', text: 'original' } };
  try {
    await post('/api/mock-events', event);
    const goal = await post('/api/goals', { project: 'alpha', title: 'Review', completion: 'Draft' });
    await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
    await post('/api/mock-events', { ...event, revision: 2, operation: 'delete', details: null });
    await post('/api/scheduler/tick');
    const detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.goal.current_plan, 1);
    assert.equal(detail.automation.jobs.find((j: any) => j.kind === 'event').status, 'stopped');
    assert.equal(detail.automation.runs.length, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
