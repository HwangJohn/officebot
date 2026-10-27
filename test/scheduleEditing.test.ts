import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';

test('schedule changes and recreation preserve history, isolate goals and survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-edit-')), dbPath = join(dir, 'test.sqlite');
  let time = Date.parse('2026-10-27T00:00:00Z');
  let app = buildServer({ dbPath, schedulerClock: () => time });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const get = async (id: string) => (await app.inject(`/api/goals/${id}`)).json();
  try {
    for (const project of ['alpha', 'beta']) assert.equal((await post('/api/mock-events', { source: 'teams', account: 'mock:primary', project, externalId: 'request', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'test', text: 'Synthetic evidence' } })).statusCode, 200);
    const alphaResponse = await post('/api/goals', { project: 'alpha', title: 'Alpha', completion: 'Review' });
    const betaResponse = await post('/api/goals', { project: 'beta', title: 'Beta', completion: 'Review' });
    assert.equal(alphaResponse.statusCode, 200); assert.equal(betaResponse.statusCode, 200);
    const alpha = alphaResponse.json(), beta = betaResponse.json();
    const url = `/api/goals/${alpha.id}/schedules`;
    const initial = (await post(url, { kind: 'daily_review', firstDueAt: time, civil: { timeZone: 'Asia/Seoul', minuteOfDay: 540 } })).json();
    await post('/api/scheduler/tick', {});
    let detail = await get(alpha.id);
    assert.equal(detail.automation.jobs.filter((job: any) => job.schedule_id === initial.scheduleId).length, 1);
    const invalid = await post(url, { kind: 'daily_review', firstDueAt: time, expectedScheduleId: initial.scheduleId, civil: { timeZone: 'invalid/zone', minuteOfDay: 600 } });
    assert.equal(invalid.statusCode, 422);
    detail = await get(alpha.id);
    assert.equal(detail.automation.schedules.find((s: any) => s.current).active, 1);
    const edited = await post(url, { kind: 'daily_review', firstDueAt: time + 86_400_000, expectedScheduleId: initial.scheduleId, civil: { timeZone: 'Asia/Seoul', minuteOfDay: 600 } });
    assert.equal(edited.statusCode, 200); const second = edited.json().scheduleId;
    assert.notEqual(second, initial.scheduleId);
    assert.equal((await post(url, { kind: 'daily_review', firstDueAt: time, expectedScheduleId: initial.scheduleId, civil: { timeZone: 'UTC', minuteOfDay: 0 } })).statusCode, 409);
    assert.equal((await post(`/api/goals/${alpha.id}/schedules/daily_review/cancel`, { expectedScheduleId: initial.scheduleId })).statusCode, 409);
    assert.equal((await post(`/api/goals/${alpha.id}/schedules/daily_review/cancel`, { expectedScheduleId: second })).json().cancelled, true);
    const recreated = await post(url, { kind: 'daily_review', firstDueAt: time + 2 * 86_400_000, expectedScheduleId: second, civil: { timeZone: 'Asia/Seoul', minuteOfDay: 660 } });
    assert.equal(recreated.statusCode, 200); const third = recreated.json().scheduleId;
    assert.notEqual(third, second);
    await app.close(); app = buildServer({ dbPath, schedulerClock: () => time });
    detail = await get(alpha.id);
    assert.equal(detail.automation.schedules.filter((s: any) => s.current).length, 1);
    assert.equal(detail.automation.schedules.find((s: any) => s.current).schedule_id, third);
    assert.equal(detail.automation.schedules.find((s: any) => s.schedule_id === initial.scheduleId).active, 0);
    assert.equal(detail.automation.jobs.filter((job: any) => job.schedule_id === initial.scheduleId).length, 1);
    assert.equal((await get(beta.id)).automation.schedules.length, 0);
    time += 2 * 86_400_000 + 2 * 3_600_000;
    await post('/api/scheduler/tick', {}); await post('/api/scheduler/tick', {});
    detail = await get(alpha.id);
    assert.equal(detail.automation.jobs.filter((job: any) => job.schedule_id === third).length, 1);
    assert.equal(detail.automation.jobs.filter((job: any) => job.schedule_id === second).length, 0);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('replacing a schedule at an already reviewed occurrence does not duplicate that review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-dedup-')), dbPath = join(dir, 'test.sqlite');
  const time = Date.parse('2026-10-27T00:00:00Z');
  const app = buildServer({ dbPath, schedulerClock: () => time });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  try {
    await post('/api/mock-events', { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'test', text: 'Evidence' } });
    const goal = (await post('/api/goals', { project: 'alpha', title: 'Alpha', completion: 'Review' })).json();
    const url = `/api/goals/${goal.id}/schedules`, civil = { timeZone: 'Asia/Seoul', minuteOfDay: 540 };
    const first = (await post(url, { kind: 'daily_review', firstDueAt: time, civil })).json();
    await post('/api/scheduler/tick', {});
    assert.equal((await app.inject(`/api/goals/${goal.id}`)).json().automation.reviews.length, 1);
    assert.equal((await post(url, { kind: 'daily_review', firstDueAt: time, expectedScheduleId: first.scheduleId, civil })).statusCode, 200);
    await post('/api/scheduler/tick', {});
    const detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.automation.reviews.length, 1);
    assert.equal(detail.automation.schedules.find((schedule: any) => schedule.current).next_due, time + 86_400_000);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('replacing a fixed UTC schedule preserves its cadence after a completed occurrence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-utc-dedup-')), dbPath = join(dir, 'test.sqlite');
  const time = Date.parse('2026-10-27T00:00:00Z');
  const app = buildServer({ dbPath, schedulerClock: () => time });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  try {
    await post('/api/mock-events', { source: 'teams', account: 'mock:primary', project: 'alpha', externalId: 'one', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: 'test', text: 'Evidence' } });
    const goal = (await post('/api/goals', { project: 'alpha', title: 'Alpha', completion: 'Review' })).json();
    const url = `/api/goals/${goal.id}/schedules`;
    const first = (await post(url, { kind: 'daily_review', firstDueAt: time })).json();
    await post('/api/scheduler/tick', {});
    assert.equal((await post(url, { kind: 'daily_review', firstDueAt: time, expectedScheduleId: first.scheduleId })).statusCode, 200);
    await post('/api/scheduler/tick', {});
    const detail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(detail.automation.reviews.length, 1);
    assert.equal(detail.automation.schedules.find((schedule: any) => schedule.current).next_due, time + 86_400_000);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
