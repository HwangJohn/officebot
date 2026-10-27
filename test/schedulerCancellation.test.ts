import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.js';
import { createDurableScheduler, type HandlerContext } from '../src/durableScheduler.js';

test('cancelling a schedule prevents its queued occurrence while another goal is running', async () => {
  const db = new Db(':memory:');
  const time = Date.UTC(2026, 9, 27);
  const scheduler = createDurableScheduler(db, { now: () => time, maxPerTick: 2 });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let running: Promise<unknown> | undefined;
  try {
    for (const id of ['alpha', 'beta']) {
      db.run('INSERT INTO workflow_goals(id,title,owner,completion,created_at) VALUES(?,?,?,?,?)', [id, id, 'owner', 'done', '2026-10-27T00:00:00Z']);
      scheduler.schedule({ goalId: id, scheduleId: 'daily', kind: 'daily_review', payload: {}, semantics: 'local_idempotent', firstDueAt: time, recurrence: 'daily' });
    }
    const seen: string[] = [];
    running = scheduler.tick(async ctx => {
      seen.push(ctx.goalId);
      if (seen.length === 1) { entered(); await gate; }
      return { outcome: 'progress' };
    });
    await ready;
    const cancelledGoal = seen[0] === 'alpha' ? 'beta' : 'alpha';
    assert.equal((scheduler.inspect(cancelledGoal).jobs[0] as any).status, 'pending');
    assert.equal(scheduler.cancelSchedule(cancelledGoal, 'daily'), true);
    release(); await running;
    assert.equal(seen.includes(cancelledGoal), false);
    assert.equal((scheduler.inspect(cancelledGoal).jobs[0] as any).status, 'cancelled');
    assert.equal((scheduler.inspect(cancelledGoal).schedules[0] as any).active, 0);
    assert.equal((scheduler.inspect(seen[0]).jobs[0] as any).status, 'succeeded');
  } finally { release(); await running; db.close(); }
});

for (const semantics of ['local_idempotent', 'external_unknown'] as const) {
  test(`schedule cancellation fences an in-flight ${semantics} occurrence`, async () => {
    const db = new Db(':memory:');
    const time = Date.UTC(2026, 9, 27);
    const scheduler = createDurableScheduler(db, { now: () => time, maxPerTick: 1 });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let running: Promise<unknown> | undefined;
    let active: HandlerContext | undefined;
    try {
      db.run('INSERT INTO workflow_goals(id,title,owner,completion,created_at) VALUES(?,?,?,?,?)', ['alpha', 'alpha', 'owner', 'done', '2026-10-27T00:00:00Z']);
      scheduler.schedule({ goalId: 'alpha', scheduleId: 'daily', kind: 'daily_review', payload: {}, semantics, firstDueAt: time, recurrence: 'daily' });
      running = scheduler.tick(async ctx => { active = ctx; entered(); await gate; return { outcome: 'progress' }; });
      await ready;
      assert.equal(scheduler.cancelSchedule('alpha', 'daily'), true);
      const expected = semantics === 'external_unknown' ? 'held' : 'cancelled';
      assert.equal((scheduler.inspect('alpha').jobs[0] as any).status, expected);
      if (semantics === 'local_idempotent') assert.throws(() => scheduler.saveReview(active!, { summary: 'Review', evidence: [{ source: 'jira', reference: 'one', excerpt: 'Evidence' }], proposals: [] }), /review_lease_invalid/);
      release(); await running;
      assert.equal((scheduler.inspect('alpha').jobs[0] as any).status, expected);
      assert.equal((scheduler.inspect('alpha').runs[0] as any).outcome, 'cancelled');
      if (semantics === 'external_unknown') {
        const job = scheduler.inspect('alpha').jobs[0] as any;
        assert.equal(scheduler.reconcile('alpha', job.id, 'confirmed_not_sent', 'Independent check'), 'cancelled');
        assert.equal((await scheduler.tick(async () => { throw new Error('must_not_retry'); })).started, 0);
      }
    } finally { release(); await running; db.close(); }
  });
}

test('cancelling a schedule prevents replay of an older held occurrence after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cancel-held-')), path = join(dir, 'test.sqlite');
  let db = new Db(path);
  const time = Date.UTC(2026, 9, 27);
  let scheduler = createDurableScheduler(db, { now: () => time, maxPerTick: 1 });
  try {
    db.run('INSERT INTO workflow_goals(id,title,owner,completion,created_at) VALUES(?,?,?,?,?)', ['alpha', 'alpha', 'owner', 'done', '2026-10-27T00:00:00Z']);
    scheduler.schedule({ goalId: 'alpha', scheduleId: 'daily', kind: 'daily_review', payload: {}, semantics: 'external_unknown', firstDueAt: time, recurrence: 'daily' });
    await scheduler.tick(async () => { throw new Error('unknown_outcome'); });
    const held = scheduler.inspect('alpha').jobs[0] as any;
    assert.equal(held.status, 'held');
    assert.equal(scheduler.cancelSchedule('alpha', 'daily'), true);
    db.close(); db = new Db(path); scheduler = createDurableScheduler(db, { now: () => time, maxPerTick: 1 });
    assert.equal(scheduler.reconcile('alpha', held.id, 'confirmed_not_sent', 'Independent check'), 'cancelled');
    assert.equal((await scheduler.tick(async () => { throw new Error('must_not_retry'); })).started, 0);
    assert.equal((scheduler.inspect('alpha').jobs[0] as any).status, 'cancelled');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an independently confirmed sent occurrence stays succeeded after schedule cancellation', async () => {
  const db = new Db(':memory:');
  const time = Date.UTC(2026, 9, 27);
  const scheduler = createDurableScheduler(db, { now: () => time });
  try {
    db.run('INSERT INTO workflow_goals(id,title,owner,completion,created_at) VALUES(?,?,?,?,?)', ['alpha', 'alpha', 'owner', 'done', '2026-10-27T00:00:00Z']);
    scheduler.schedule({ goalId: 'alpha', scheduleId: 'daily', kind: 'daily_review', payload: {}, semantics: 'external_unknown', firstDueAt: time, recurrence: 'daily' });
    await scheduler.tick(async () => { throw new Error('unknown_outcome'); });
    const job = scheduler.inspect('alpha').jobs[0] as any;
    assert.equal(scheduler.cancelSchedule('alpha', 'daily'), true);
    assert.equal(scheduler.reconcile('alpha', job.id, 'confirmed_sent', 'Independent receipt'), 'succeeded');
    assert.equal((scheduler.inspect('alpha').jobs[0] as any).status, 'succeeded');
    assert.equal(scheduler.inspect('alpha').reconciliations.length, 1);
  } finally { db.close(); }
});
