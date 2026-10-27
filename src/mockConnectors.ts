import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { j } from './db.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const common = {
  account: z.string().regex(/^mock:[a-zA-Z0-9_-]{1,80}$/),
  project: text(200), externalId: text(200), revision: z.number().int().min(1).max(1_000_000),
  occurredAt: text(50).refine(value => Number.isFinite(Date.parse(value))),
  operation: z.enum(['upsert', 'delete'])
};
const schema = z.discriminatedUnion('source', [
  z.object({ ...common, source: z.literal('teams'), details: z.object({ channel: text(100), text: text(2000) }).strict().nullable() }).strict(),
  z.object({ ...common, source: z.literal('outlook'), details: z.object({ subject: text(200), body: text(2000) }).strict().nullable() }).strict(),
  z.object({ ...common, source: z.literal('jira'), details: z.object({ issueKey: text(100), status: text(100), summary: text(500) }).strict().nullable() }).strict(),
  z.object({ ...common, source: z.literal('confluence'), details: z.object({ pageId: text(100), title: text(200), body: text(2000) }).strict().nullable() }).strict()
]);
export type MockConnectorEvent = z.infer<typeof schema>;

function display(event: MockConnectorEvent) {
  if (!event.details) return { title: event.externalId, body: '' };
  switch (event.source) {
    case 'teams': return { title: event.details.channel, body: event.details.text };
    case 'outlook': return { title: event.details.subject, body: event.details.body };
    case 'jira': return { title: event.details.issueKey, body: `${event.details.summary} (${event.details.status})` };
    case 'confluence': return { title: event.details.title, body: event.details.body };
  }
}
function digest(value: unknown) { return createHash('sha256').update(j.str(value)).digest('hex'); }

export function createMockConnectors(db: Db, clock: () => string, onLatest?: (project: string, eventId: number) => void) {
  function ingest(input: unknown) {
    const event = schema.parse(input);
    if ((event.operation === 'upsert') !== (event.details !== null)) throw new Error('invalid_mock_operation');
    const contentHash = digest({ occurredAt: event.occurredAt, operation: event.operation, details: event.details });
    const key = [event.source, event.account, event.project, event.externalId];
    return db.tx(() => {
      const old = db.get<{ content_hash: string; event_id: number }>('SELECT content_hash,event_id FROM mock_connector_events WHERE source=? AND account=? AND project=? AND external_id=? AND revision=?', [...key, event.revision]);
      if (old) {
        if (old.content_hash !== contentHash) throw new Error('mock_revision_conflict');
        return { inserted: false, reason: 'duplicate' as const, eventId: old.event_id };
      }
      const latest = db.get<{ revision: number }>('SELECT revision FROM mock_connector_events WHERE source=? AND account=? AND project=? AND external_id=? ORDER BY revision DESC LIMIT 1', key);
      const isLatest = !latest || event.revision > latest.revision;
      if (isLatest) db.run('UPDATE evidence SET trusted=0 WHERE event_id IN (SELECT event_id FROM mock_connector_events WHERE source=? AND account=? AND project=? AND external_id=?)', key);
      const sourceId = `mock-${digest([...key, event.revision])}`;
      const content = display(event);
      const stored = db.run('INSERT INTO events(source,source_event_id,occurred_at,project,kind,title,body,raw_json,processed_at) VALUES(?,?,?,?,?,?,?,?,?)', [event.source, sourceId, event.occurredAt, event.project, 'mock_record', content.title, content.body, j.str(event), clock()]);
      const eventId = Number(stored.lastInsertRowid);
      db.run('INSERT INTO evidence(event_id,source,title,excerpt,trusted,created_at) VALUES(?,?,?,?,?,?)', [eventId, event.source, content.title, content.body.slice(0, 240), isLatest && event.operation === 'upsert' ? 1 : 0, clock()]);
      db.run('INSERT INTO mock_connector_events(source,account,project,external_id,revision,occurred_at,operation,details_json,content_hash,event_id,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [...key, event.revision, event.occurredAt, event.operation, j.str(event.details), contentHash, eventId, clock()]);
      if (isLatest) onLatest?.(event.project, eventId);
      return { inserted: true, latest: isLatest, eventId };
    });
  }
  function query(project: string, source: MockConnectorEvent['source'], account: string) {
    if (typeof project !== 'string' || !project.trim() || project.length > 200 || !['teams', 'outlook', 'jira', 'confluence'].includes(source) || !/^mock:[a-zA-Z0-9_-]{1,80}$/.test(account)) throw new Error('invalid_mock_scope');
    return db.all<{ external_id: string; revision: number; occurred_at: string; operation: string; details_json: string; event_id: number }>(`SELECT external_id,revision,occurred_at,operation,details_json,event_id FROM mock_connector_events m
      WHERE project=? AND source=? AND account=? AND operation='upsert' AND revision=(SELECT MAX(revision) FROM mock_connector_events x WHERE x.source=m.source AND x.account=m.account AND x.project=m.project AND x.external_id=m.external_id)
      ORDER BY occurred_at,event_id`, [project, source, account]).map(row => ({ externalId: row.external_id, revision: row.revision, occurredAt: row.occurred_at, details: j.parse(row.details_json, null), eventId: row.event_id }));
  }
  return { ingest, query };
}
