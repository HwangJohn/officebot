import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.js';
import { createDurableScheduler, type HandlerContext, type JobKind } from '../src/durableScheduler.js';

const DAY = 86_400_000;
function fixture(options: { maxPerTick?: number; maxStartsPerGoalPerUtcDay?: number; leaseMs?: number; retryBaseMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'durable-scheduler-'));
  const path = join(dir, 'isolated.sqlite');
  let time = Date.UTC(2026, 9, 27);
  let db = new Db(path);
  const open = () => createDurableScheduler(db, { now: () => time, leaseMs: 100, retryBaseMs: 10, ...options });
  for (const id of ['alpha', 'beta']) db.run('INSERT INTO workflow_goals(id,title,owner,completion,created_at) VALUES(?,?,?,?,?)', [id, id, 'owner', 'done', '2026-10-27T00:00:00Z']);
  return { get db() { return db; }, get time() { return time; }, set time(v: number) { time = v; }, open, restart() { db.close(); db = new Db(path); return open(); }, cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const artifact = { summary: 'Review', evidence: [{ source: 'jira', reference: 'issue-1', excerpt: 'A delay was observed' }], proposals: [{ description: 'Review the handoff', evidenceReferences: ['issue-1'] }] };
const event = (goalId: string, eventId: string, dueAt: number, kind: JobKind = 'event') => ({ goalId, eventId, dueAt, kind, payload: { topic: 'wake' }, semantics: 'local_idempotent' as const });
const progress = async () => ({ outcome: 'progress' as const });
const rows = (value: unknown[]) => value as Array<Record<string, any>>;

test('expired planner lease fences only its own attempt and keeps its budget charge', async () => {
  const f = fixture({ maxPerTick: 1 }); const scheduler = f.open();
  let releaseA!: () => void, releaseB!: () => void, enteredA!: () => void, enteredB!: () => void;
  const gateA = new Promise<void>(resolve => { releaseA = resolve; }), gateB = new Promise<void>(resolve => { releaseB = resolve; });
  const readyA = new Promise<void>(resolve => { enteredA = resolve; }), readyB = new Promise<void>(resolve => { enteredB = resolve; });
  try {
    for (const goal of ['alpha', 'beta']) f.db.run('INSERT INTO workflow_planner_policies(goal_id,version,policy_json,created_at) VALUES(?,1,?,?)', [goal, '{}', '2026-10-27T00:00:00Z']);
    const reserveAttempt = (ctx: HandlerContext) => {
      const id = Number(f.db.run("INSERT INTO workflow_planner_attempts(goal_id,policy_version,status,created_at) VALUES(?,1,'running',?)", [ctx.goalId, '2026-10-27T00:00:00Z']).lastInsertRowid);
      f.db.run('INSERT INTO workflow_planner_attempt_leases(attempt_id,job_id,run_id,lease_token) VALUES(?,?,?,?)', [id, ctx.jobId, ctx.runId, ctx.leaseToken]);
      return id;
    };
    let firstId = 0, secondId = 0;
    scheduler.enqueue(event('alpha', 'a', f.time));
    const first = scheduler.tick(async ctx => { firstId = reserveAttempt(ctx); enteredA(); await gateA; return { outcome: 'progress' }; }); await readyA;
    f.time += 50; scheduler.enqueue(event('beta', 'b', f.time));
    const second = scheduler.tick(async ctx => { secondId = reserveAttempt(ctx); enteredB(); await gateB; return { outcome: 'progress' }; }); await readyB;
    f.time += 51; await scheduler.tick(progress);
    assert.equal(f.db.get<any>('SELECT status FROM workflow_planner_attempts WHERE id=?', [firstId]).status, 'failed');
    assert.equal(f.db.get<any>('SELECT code FROM workflow_planner_diagnostics WHERE attempt_id=?', [firstId]).code, 'planner_attempt_fenced');
    assert.equal(f.db.get<any>('SELECT status FROM workflow_planner_attempts WHERE id=?', [secondId]).status, 'running');
    assert.equal(f.db.get('SELECT code FROM workflow_planner_diagnostics WHERE attempt_id=?', [secondId]), undefined);
    assert.equal(f.db.get<any>("SELECT count(*) n FROM workflow_planner_attempts WHERE goal_id='alpha'").n, 1);
    releaseA(); await first;
    assert.equal(f.db.get<any>('SELECT status FROM workflow_planner_attempts WHERE id=?', [firstId]).status, 'failed');
    releaseB(); await second;
    assert.equal(f.db.get<any>('SELECT status FROM workflow_planner_attempts WHERE id=?', [secondId]).status, 'failed');
  } finally { releaseA(); releaseB(); f.cleanup(); }
});

test('daily and weekly reviews survive restart, isolate goals and skip old missed occurrences', async () => {
  const f = fixture(); let s = f.open();
  try {
    s.schedule({ goalId: 'alpha', scheduleId: 'daily', kind: 'daily_review', payload: {}, semantics: 'local_idempotent', firstDueAt: f.time + DAY, recurrence: 'daily' });
    s.schedule({ goalId: 'beta', scheduleId: 'weekly', kind: 'weekly_review', payload: {}, semantics: 'local_idempotent', firstDueAt: f.time + 7 * DAY, recurrence: 'weekly' });
    f.time += DAY;
    const handler = async (ctx: HandlerContext) => { s.saveReview(ctx, artifact); return { outcome: 'progress' as const }; };
    assert.equal((await s.tick(handler)).started, 1);
    assert.equal(rows(s.inspect('alpha').reviews)[0].approval_status, 'human_review_required');
    assert.equal(s.inspect('beta').reviews.length, 0);
    s = f.restart(); f.time += 6 * DAY;
    assert.equal((await s.tick(handler)).started, 2);
    assert.equal(s.inspect('alpha').reviews.length, 2); // days 2-6 deliberately coalesced into day 7
    assert.equal(s.inspect('beta').reviews.length, 1);
    assert.equal(rows(s.inspect('alpha').jobs)[1].scheduled_for, f.time);
    assert.equal((await s.tick(handler)).started, 0);
    f.time += 35 * DAY;
    assert.equal((await s.tick(handler)).started, 2); // bounded, no unbounded backlog
    assert.equal(s.inspect('alpha').reviews.length, 3);
    assert.equal(s.inspect('beta').reviews.length, 2);
    assert.throws(() => s.saveReview({} as HandlerContext, { ...artifact, proposals: [{ description: 'change code', evidenceReferences: ['fake'] }] }), /invalid_review_artifact/);
  } finally { f.cleanup(); }
});

test('healthy reviews use the shared store with evidence and lease fencing', async () => {
  const f = fixture(); const s = f.open();
  try {
    const healthy = { ...artifact, proposals: [] };
    s.enqueue(event('alpha', 'healthy', f.time, 'daily_review'));
    let saved: HandlerContext | undefined;
    await s.tick(async ctx => {
      saved = ctx;
      assert.throws(() => s.saveReview(ctx, { ...healthy, evidence: [] }), /invalid_review_artifact/);
      assert.throws(() => s.saveReview(ctx, { ...healthy, proposals: [{ description: 'bad', evidenceReferences: ['missing'] }] }), /invalid_review_artifact/);
      assert.equal(s.saveReview(ctx, healthy).approvalStatus, 'no_action');
      assert.equal(s.saveReview(ctx, healthy).approvalStatus, 'no_action');
      return { outcome: 'progress' };
    });
    assert.equal(rows(s.inspect('alpha').reviews)[0].approval_status, 'no_action');
    assert.throws(() => s.saveReview(saved!, healthy), /review_lease_invalid/);
  } finally { f.cleanup(); }
});

test('event deduplication and explicit quiet-time coalescing keep both event identities', async () => {
  const f = fixture(); const s = f.open();
  try {
    const quietEnd = f.time + 8 * 3_600_000;
    const a = { ...event('alpha', 'source/account/one/v1', quietEnd, 'notification'), coalesceKey: 'morning' };
    const b = { ...a, eventId: 'source/account/two/v1' };
    const first = s.enqueue(a);
    assert.equal(s.enqueue(a).duplicate, true);
    assert.throws(() => s.enqueue({ ...a, payload: 'changed' }), /event_conflict/);
    assert.equal(s.enqueue(b).jobId, first.jobId);
    assert.notEqual(s.enqueue({ ...a, goalId: 'beta' }).jobId, first.jobId);
    assert.equal((await s.tick(progress)).started, 0);
    f.time = quietEnd;
    const seen: HandlerContext[] = [];
    assert.equal((await s.tick(async ctx => { seen.push(ctx); return { outcome: 'progress' }; })).started, 2);
    assert.deepEqual(seen.find(x => x.goalId === 'alpha')?.eventIds, [a.eventId, b.eventId]);
    assert.equal((await s.tick(progress)).started, 0);
  } finally { f.cleanup(); }
});

test('coalesced event batches have a bounded handler input', async () => {
  const f = fixture(); const s = f.open();
  try {
    for (let i = 0; i < 101; i++) s.enqueue({ ...event('alpha', `event-${i}`, f.time, 'notification'), coalesceKey: 'batch' });
    const sizes: number[] = [];
    await s.tick(async ctx => { sizes.push(ctx.eventIds.length); return { outcome: 'progress' }; });
    assert.deepEqual(sizes.sort((a, b) => a - b), [1, 100]);
  } finally { f.cleanup(); }
});

test('concurrent ticks do not run two jobs for the same goal', async () => {
  const f = fixture(); const s = f.open();
  try {
    s.enqueue(event('alpha', 'one', f.time)); s.enqueue(event('alpha', 'two', f.time));
    let finish!: (v: { outcome: 'progress' }) => void;
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const first = s.tick(() => { if (calls++ > 0) return progress(); entered(); return new Promise(resolve => { finish = resolve; }); });
    await started;
    assert.equal((await s.tick(progress)).started, 0);
    finish({ outcome: 'progress' });
    await first;
    assert.equal(calls, 2);
  } finally { f.cleanup(); }
});

test('expired local lease recovers after restart with stable effect id and no duplicate local effects', async () => {
  const f = fixture(); let s = f.open();
  try {
    f.db.db.exec('CREATE TABLE local_effects(effect_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const job = s.enqueue(event('alpha', 'crash', f.time));
    let first: HandlerContext | undefined;
    // Simulate a process dying after committing an idempotent effect but before completing its run.
    void s.tick(async ctx => { first = ctx; f.db.run('INSERT OR IGNORE INTO local_effects VALUES(?,?)', [ctx.effectId, 'done']); return new Promise(() => {}); });
    assert.ok(first);
    s = f.restart(); f.time += 101;
    assert.equal((await s.tick(progress)).recovered, 1);
    f.time += 10;
    let retry: HandlerContext | undefined;
    await s.tick(async ctx => { retry = ctx; f.db.run('INSERT OR IGNORE INTO local_effects VALUES(?,?)', [ctx.effectId, 'done']); return { outcome: 'progress' }; });
    assert.equal(retry?.effectId, job.jobId);
    assert.notEqual(retry?.runId, first?.runId);
    assert.equal(f.db.get<{ n: number }>('SELECT count(*) n FROM local_effects')?.n, 1);
    assert.equal(rows(s.inspect('alpha').jobs)[0].status, 'succeeded');
  } finally { f.cleanup(); }
});

test('external failure or expired lease is held; verified reconciliation is audited', async () => {
  const f = fixture(); let s = f.open();
  try {
    const one = s.enqueue({ ...event('alpha', 'external-1', f.time), semantics: 'external_unknown' });
    await s.tick(async () => { throw new Error('timeout'); });
    assert.equal(rows(s.inspect('alpha').jobs)[0].status, 'held');
    assert.equal((await s.tick(progress)).started, 0);
    assert.equal(s.reconcile('alpha', one.jobId, 'confirmed_not_sent', 'Provider confirmed no write'), 'pending');
    await s.tick(progress);
    assert.equal(rows(s.inspect('alpha').jobs)[0].status, 'succeeded');
    assert.equal(s.inspect('alpha').reconciliations.length, 1);
    const two = s.enqueue({ ...event('beta', 'external-2', f.time), semantics: 'external_unknown' });
    void s.tick(async () => new Promise(() => {}));
    s = f.restart(); f.time += 101;
    await s.tick(progress);
    assert.equal(rows(s.inspect('beta').jobs)[0].status, 'held');
    assert.throws(() => s.reconcile('alpha', two.jobId, 'confirmed_sent', 'verified'), /held_job_not_found/);
    assert.equal(s.reconcile('beta', two.jobId, 'confirmed_sent', 'Provider receipt verified'), 'succeeded');
  } finally { f.cleanup(); }
});

test('stale completions cannot clear an external hold, and cancelling an in-flight send stays cancelled after reconciliation', async () => {
  const f = fixture(); const s = f.open();
  try {
    const first = s.enqueue({ ...event('alpha', 'late', f.time), semantics: 'external_unknown' });
    let finish!: (value: { outcome: 'progress' }) => void;
    const oldTick = s.tick(() => new Promise(resolve => { finish = resolve; }));
    f.time += 101;
    await s.tick(progress);
    finish({ outcome: 'progress' }); await oldTick;
    assert.equal(rows(s.inspect('alpha').jobs)[0].status, 'held');
    assert.equal(s.reconcile('alpha', first.jobId, 'confirmed_sent', 'Receipt checked'), 'succeeded');
    const second = s.enqueue({ ...event('beta', 'cancel-send', f.time), semantics: 'external_unknown' });
    let finishSecond!: (value: { outcome: 'progress' }) => void;
    const running = s.tick(() => new Promise(resolve => { finishSecond = resolve; }));
    assert.equal(s.cancelJob('beta', second.jobId), true);
    finishSecond({ outcome: 'progress' }); await running;
    assert.equal(rows(s.inspect('beta').jobs)[0].status, 'held');
    assert.equal(s.reconcile('beta', second.jobId, 'confirmed_not_sent', 'Provider confirms no send'), 'cancelled');
    const third = s.enqueue({ ...event('alpha', 'no-progress-send', f.time), semantics: 'external_unknown' });
    await s.tick(async () => ({ outcome: 'no_progress' }));
    assert.equal(rows(s.inspect('alpha').jobs).find(x => x.id === third.jobId)?.status, 'held');
  } finally { f.cleanup(); }
});

test('retries are bounded and delayed, no-progress stops, and UTC daily budget isolates goals', async () => {
  const f = fixture({ maxStartsPerGoalPerUtcDay: 2 }); const s = f.open();
  try {
    const job = s.enqueue({ ...event('alpha', 'fails', f.time), maxAttempts: 3 });
    const failed = async () => { throw new Error('no'); };
    await s.tick(failed); assert.equal((await s.tick(failed)).started, 0);
    f.time += 10; await s.tick(failed);
    f.time += 20; assert.equal((await s.tick(failed)).started, 0);
    s.enqueue(event('beta', 'stuck', f.time));
    await s.tick(async () => ({ outcome: 'no_progress' }));
    assert.equal(rows(s.inspect('beta').jobs)[0].status, 'stopped');
    f.time = Math.floor(f.time / DAY) * DAY + DAY;
    await s.tick(failed);
    assert.equal(rows(s.inspect('alpha').jobs).find(x => x.id === job.jobId)?.status, 'failed');
    assert.equal(s.inspect('alpha').runs.length, 3);
    assert.equal((await s.tick(failed)).started, 0);
  } finally { f.cleanup(); }
});

test('bounded ticks, cancellation, and stale lease cannot commit a review', async () => {
  const f = fixture({ maxPerTick: 1 }); const s = f.open();
  try {
    s.schedule({ goalId: 'alpha', scheduleId: 'off', kind: 'daily_review', payload: {}, semantics: 'local_idempotent', firstDueAt: f.time, recurrence: 'daily' });
    assert.equal(s.cancelSchedule('alpha', 'off'), true);
    const cancelled = s.enqueue(event('alpha', 'cancel', f.time));
    assert.equal(s.cancelJob('alpha', cancelled.jobId), true);
    s.enqueue(event('alpha', 'one', f.time)); s.enqueue(event('alpha', 'two', f.time));
    assert.equal((await s.tick(progress)).started, 1);
    assert.equal((await s.tick(progress)).started, 1);
    assert.equal((await s.tick(progress)).started, 0);
    const review = s.enqueue({ ...event('beta', 'review', f.time, 'daily_review') });
    let ctx: HandlerContext | undefined;
    void s.tick(async c => { ctx = c; return new Promise(() => {}); });
    assert.ok(ctx);
    assert.equal(s.cancelJob('beta', review.jobId), true);
    assert.throws(() => s.saveReview(ctx!, artifact), /review_lease_invalid/);
  } finally { f.cleanup(); }
});
