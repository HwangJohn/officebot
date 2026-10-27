import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/server.js';
import { createService } from '../src/core.js';

const common = { account: 'mock:primary', project: 'alpha', externalId: 'same-id', revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert' as const };
const records = [
  { ...common, source: 'teams' as const, details: { channel: 'general', text: 'Team planning update' } },
  { ...common, source: 'outlook' as const, details: { subject: 'Mail', body: 'Customer request' } },
  { ...common, source: 'jira' as const, details: { issueKey: 'J-1', status: 'open', summary: 'Track work' } },
  { ...common, source: 'confluence' as const, details: { pageId: 'P-1', title: 'Policy', body: 'Review required' } }
];

test('typed mock connectors isolate identity, deduplicate and handle out-of-order revisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-connectors-')); const path = join(dir, 'test.sqlite');
  let service = createService({ dbPath: path });
  try {
    for (const event of records) assert.equal(service.mockConnectors.ingest(event).inserted, true);
    assert.equal(service.mockConnectors.ingest(records[0]).inserted, false);
    assert.throws(() => service.mockConnectors.ingest({ ...records[0], details: { channel: 'general', text: 'different content' } }), /mock_revision_conflict/);
    assert.equal(service.mockConnectors.ingest({ ...records[0], project: 'beta' }).inserted, true);
    assert.equal(service.mockConnectors.ingest({ ...records[0], account: 'mock:other' }).inserted, true);
    const newest = { ...records[0], revision: 3, details: { channel: 'general', text: 'Latest update' } };
    assert.equal(service.mockConnectors.ingest(newest).latest, true);
    assert.equal(service.mockConnectors.ingest({ ...records[0], revision: 2, details: { channel: 'general', text: 'Late old update' } }).latest, false);
    assert.equal(service.mockConnectors.query('alpha', 'teams', 'mock:primary')[0].revision, 3);
    assert.equal(service.mockConnectors.query('beta', 'teams', 'mock:primary')[0].revision, 1);
    for (const event of records) assert.equal(service.mockConnectors.query('alpha', event.source, 'mock:primary').length, 1);
    assert.throws(() => service.mockConnectors.ingest({ ...records[0], account: 'real-account' }));
    assert.throws(() => service.mockConnectors.ingest({ ...records[0], details: { channel: 'general', text: 'x', extra: 'bad' } }));
    service.close();
    service = createService({ dbPath: path });
    assert.equal(service.mockConnectors.query('alpha', 'teams', 'mock:primary')[0].revision, 3);
    service.mockConnectors.ingest({ ...newest, revision: 4, operation: 'delete', details: null });
    assert.deepEqual(service.mockConnectors.query('alpha', 'teams', 'mock:primary'), []);
    assert.equal(service.mockConnectors.query('beta', 'teams', 'mock:primary').length, 1);
    const rows = service.db.all<any>("SELECT m.revision,e.trusted FROM mock_connector_events m JOIN evidence e ON e.event_id=m.event_id WHERE m.source='teams' AND m.project='alpha' AND m.account='mock:primary' ORDER BY m.revision");
    assert.deepEqual(rows.map(row => row.trusted), [0, 0, 0, 0]);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('actual goal planner reads mock connector evidence and rejects a superseded source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-api-')); const dbPath = join(dir, 'test.sqlite');
  const app = buildServer({ dbPath });
  const post = async (url: string, payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url, payload });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  try {
    await post('/api/mock-events', records[0]);
    const created = await post('/api/goals', { title: 'Team planning', completion: 'Review update', project: 'alpha' });
    await post(`/api/goals/${created.id}/plan`, { expectedVersion: 0 });
    await post(`/api/goals/${created.id}/step`, { version: 1 });
    await post('/api/mock-events', { ...records[0], revision: 2, details: { channel: 'general', text: 'Revised planning update' } });
    const stale = await app.inject({ method: 'POST', url: `/api/goals/${created.id}/step`, payload: { version: 1 } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, 'stale_evidence');
    await post(`/api/goals/${created.id}/plan`, { expectedVersion: 1 });
    await post(`/api/goals/${created.id}/step`, { version: 2 });
    await post(`/api/goals/${created.id}/step`, { version: 2 });
    const details = (await app.inject(`/api/goals/${created.id}`)).json();
    assert.match(details.artifacts[0].content, /Revised planning update/);
    assert.match(details.artifacts[0].content, /teams:same-id/);
    assert.doesNotMatch(details.artifacts[0].content, /mock-[a-f0-9]{64}/);
    assert.match(details.facts.at(-1).source, /^teams:mock-[a-f0-9]{64}$/);
    assert.doesNotMatch(details.artifacts[0].content, /Team planning update/);
    assert.equal((await app.inject('/api/state')).json().outcomes.length, 0);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
