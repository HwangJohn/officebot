import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/db.js';
import { createDurableScheduler } from '../src/durableScheduler.js';
import { firstCivilOccurrence, latestCivilOccurrence, nextCivilOccurrence } from '../src/civilSchedule.js';
import { buildServer } from '../src/server.js';

const at = (value: string) => Date.parse(value);
test('civil recurrence handles DST gaps, folds and bounded catchup', () => {
  const gap = { timeZone: 'America/New_York', minuteOfDay: 150, recurrence: 'daily' as const, weekday: 0 };
  assert.equal(firstCivilOccurrence(at('2026-03-07T07:30:00Z'), 'daily', { timeZone: gap.timeZone, minuteOfDay: gap.minuteOfDay }).dueAt, at('2026-03-07T07:30:00Z'));
  assert.equal(nextCivilOccurrence(at('2026-03-07T07:30:00Z'), gap), at('2026-03-08T07:00:00Z'));
  assert.equal(nextCivilOccurrence(at('2026-03-08T07:00:00Z'), gap), at('2026-03-09T06:30:00Z'));
  const fold = { timeZone: 'America/New_York', minuteOfDay: 90, recurrence: 'daily' as const, weekday: 0 };
  assert.equal(nextCivilOccurrence(at('2026-10-31T05:30:00Z'), fold), at('2026-11-01T05:30:00Z'));
  assert.equal(latestCivilOccurrence(at('2026-11-01T06:45:00Z'), fold), at('2026-11-01T05:30:00Z'));
  assert.equal(nextCivilOccurrence(at('2026-11-01T05:30:00Z'), fold), at('2026-11-02T06:30:00Z'));
  const skipped = { timeZone: 'Pacific/Apia', minuteOfDay: 540, recurrence: 'daily' as const, weekday: 0 };
  assert.equal(nextCivilOccurrence(at('2011-12-29T19:00:00Z'), skipped), at('2011-12-30T19:00:00Z'));
  const friday = { timeZone: 'Asia/Seoul', minuteOfDay: 540, recurrence: 'weekly' as const, weekday: 5 };
  assert.equal(latestCivilOccurrence(at('2027-11-01T12:00:00Z'), friday), at('2027-10-29T00:00:00Z'));
  assert.throws(() => firstCivilOccurrence(at('2026-01-01T00:00:00Z'), 'daily', { timeZone: 'not/a-zone', minuteOfDay: 10 }), /invalid_civil_schedule/);
});

test('weekly API accepts an explicit weekday, survives DST and rejects invalid schedules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'civil-api-')), dbPath = join(dir, 'test.sqlite');
  let time = at('2026-03-06T13:00:00Z'), app = buildServer({ dbPath, schedulerClock: () => time });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  try {
    await post('/api/mock-events', { source: 'teams', account: 'mock:test', project: 'weekly', externalId: 'one', revision: 1, occurredAt: '2026-03-06T12:00:00Z', operation: 'upsert', details: { channel: 'weekly', text: 'Review the decision' } });
    const goal = (await post('/api/goals', { project: 'weekly', title: 'Weekly', completion: 'Review' })).json();
    const url = `/api/goals/${goal.id}/schedules`;
    const invalid = await post(url, { kind: 'weekly_review', firstDueAt: time, civil: { timeZone: 'invalid/zone', minuteOfDay: 540, weekday: 5 } });
    assert.equal(invalid.statusCode, 422); assert.equal(invalid.json().code, 'invalid_civil_schedule');
    assert.equal((await post(url, { kind: 'weekly_review', firstDueAt: time, civil: { timeZone: 'America/New_York', minuteOfDay: 540, weekday: 5 } })).statusCode, 200);
    let detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.automation.schedules[0].next_due, at('2026-03-06T14:00:00Z'));
    time = at('2026-03-06T14:00:00Z'); await post('/api/scheduler/tick', {});
    await app.close(); app = buildServer({ dbPath, schedulerClock: () => time });
    detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.automation.schedules[0].next_due, at('2026-03-13T13:00:00Z'));
    time = at('2026-03-13T13:00:00Z'); await post('/api/scheduler/tick', {}); await post('/api/scheduler/tick', {});
    detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.automation.reviews.length, 2);
    assert.equal(detail.automation.schedules[0].time_zone, 'America/New_York');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('durable civil schedules survive restart, coalesce missed occurrences and isolate legacy UTC schedules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'civil-schedule-')), path = join(dir, 'test.sqlite');
  let time = at('2026-03-07T07:30:00Z'), db = new Db(path);
  const open = () => createDurableScheduler(db, { now: () => time });
  let scheduler = open();
  try {
    for (const goal of ['civil', 'legacy']) db.run('INSERT INTO workflow_goals(id,title,owner,completion,created_at) VALUES(?,?,?,?,?)', [goal, goal, 'local', 'done', '2026-01-01T00:00:00Z']);
    scheduler.schedule({ goalId: 'civil', scheduleId: 'daily', kind: 'daily_review', payload: {}, semantics: 'local_idempotent', firstDueAt: time, recurrence: 'daily', civil: { timeZone: 'America/New_York', minuteOfDay: 150 } });
    scheduler.schedule({ goalId: 'legacy', scheduleId: 'daily', kind: 'daily_review', payload: {}, semantics: 'local_idempotent', firstDueAt: time, recurrence: 'daily' });
    const run = async () => ({ outcome: 'progress' as const });
    await scheduler.tick(run);
    db.close(); db = new Db(path); scheduler = open();
    assert.equal((scheduler.inspect('civil').schedules[0] as any).next_due, at('2026-03-08T07:00:00Z'));
    assert.equal((scheduler.inspect('legacy').schedules[0] as any).next_due, at('2026-03-08T07:30:00Z'));
    time = at('2026-03-11T08:00:00Z'); await scheduler.tick(run); await scheduler.tick(run);
    const civil = scheduler.inspect('civil');
    assert.equal(civil.jobs.length, 2);
    assert.equal((civil.jobs[1] as any).scheduled_for, at('2026-03-11T06:30:00Z'));
    assert.equal((civil.schedules[0] as any).next_due, at('2026-03-12T06:30:00Z'));
    assert.equal(scheduler.inspect('legacy').jobs.length, 2);
    assert.equal((scheduler.inspect('legacy').schedules[0] as any).next_due, at('2026-03-12T07:30:00Z'));
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
