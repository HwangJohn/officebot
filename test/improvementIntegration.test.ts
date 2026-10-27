import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildServer } from '../src/server.js';

test('scheduled sourced review feeds an explicit evaluated improvement without applying it', async () => {
  const time = Date.UTC(2026, 9, 27), app = buildServer({ dbPath: ':memory:', schedulerClock: () => time });
  const original = readFileSync(new URL('../src/reviewSummary.ts', import.meta.url), 'utf8');
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  try {
    const event = { source: 'jira', account: 'mock:test', project: 'project-improvement', externalId: 'ISSUE-1', revision: 1, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { issueKey: 'ISSUE-1', status: 'blocked', summary: 'Waiting for a decision' } };
    assert.equal((await post('/api/mock-events', event)).statusCode, 200);
    const goal = (await post('/api/goals', { project: event.project, title: 'Weekly issues', completion: 'Review blocked issues' })).json();
    const noEvidence = await post(`/api/goals/${goal.id}/improvements/propose`, {});
    assert.equal(noEvidence.statusCode, 422); assert.equal(noEvidence.json().code, 'improvement_no_review_evidence');
    assert.equal((await post(`/api/goals/${goal.id}/improvements/propose`, { patch: 'untrusted' })).statusCode, 400);
    assert.equal((await post(`/api/goals/${goal.id}/schedules`, { kind: 'weekly_review', firstDueAt: time })).statusCode, 200);
    await post('/api/scheduler/tick', {});
    const goalDetail = (await app.inject(`/api/goals/${goal.id}`)).json();
    assert.equal(goalDetail.automation.reviews[0].artifact.summary, '주간 점검: Weekly issues');
    assert.equal(goalDetail.automation.reviews[0].artifact.proposals.length, 1);
    const response = await post(`/api/goals/${goal.id}/improvements/propose`, {});
    assert.equal(response.statusCode, 200);
    const proposal = response.json();
    assert.equal(proposal.scope, 'review_summary_v1');
    assert.ok(proposal.evidenceSnapshot.sources.some((source: any) => source.blocked));
    const review = await post(`/api/goals/${goal.id}/improvements/${proposal.id}/review`, {});
    assert.equal(review.statusCode, 200); assert.equal(review.json().status, 'review_required');
    assert.ok(review.json().review.checks.every((check: any) => check.passed));
    assert.match(review.json().review.example.after, /차단·지연 1건/);
    assert.equal(readFileSync(new URL('../src/reviewSummary.ts', import.meta.url), 'utf8'), original);
    assert.equal((await app.inject(`/api/goals/${goal.id}/improvements`)).json().length, 1);
  } finally { await app.close(); }
});
