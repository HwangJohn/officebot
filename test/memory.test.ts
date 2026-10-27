import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/core.js';
import { fixtures } from '../src/fixtures.js';

test('analysis consumes scoped, correctable user memory after restart without treating it as evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-memory-')); const dbPath = join(dir, 'test.sqlite');
  const seen: any[] = [];
  const analystAdapterFactory = () => ({ engine: 'offline-mock' as const, analyze: async (_goal: string, ctx: any) => {
    seen.push(ctx);
    const ids = [ctx.evidence[0].id];
    return { output: { status: 'success' as const, koreanSummary: '근거 확인', summaryEvidenceIds: ids, observations: [], suggestedNextSteps: [], missingInformation: [], draftProposal: { title: '검토', body: '검토용', evidenceIds: ids } } };
  } });
  let service = createService({ dbPath, analystAdapterFactory });
  try {
    service.ingest(fixtures[0]);
    const message = service.addMessage({ role: 'user', content: '제안서 비용은 99라고 들었어요' })[0];
    service.memory.setPreference(fixtures[0].project, 'local', 'response_style', 'brief', 0);
    service.memory.setPreference(fixtures[6].project, 'local', 'response_style', 'detailed', 0);
    service.memory.setPreference(fixtures[0].project, 'another-user', 'response_style', 'private', 0);
    service.close();
    service = createService({ dbPath, analystAdapterFactory });
    const first = await service.analyzeGoal('제안서 비용 확인');
    assert.equal(seen[0].memory.preferences[0].value, 'brief');
    assert.match(seen[0].memory.conversation[0].source, /web:message:1:v0/);
    assert.equal(seen[0].evidence.length, 1);
    assert.equal(seen[0].evidence.some((e: any) => e.excerpt.includes('99')), false);
    assert.equal(first.memorySources.preferences[0].source, 'preference:response_style:v1');
    service.memory.correctMessage(message.id, 0, '제안서 비용은 확인되지 않았어요');
    assert.equal(service.state().latestAnalysis?.stale, true);
    await service.analyzeGoal('제안서 비용 확인');
    assert.match(seen[1].memory.conversation[0].content, /확인되지/);
    assert.match(seen[1].memory.conversation[0].source, /:v1$/);
    assert.throws(() => service.memory.correctMessage(message.id, 0, null), /stale_message/);
    service.memory.correctMessage(message.id, 1, null);
    service.memory.setPreference(fixtures[0].project, 'local', 'response_style', null, 1);
    service.close();
    service = createService({ dbPath, analystAdapterFactory });
    await service.analyzeGoal('제안서 비용 확인');
    assert.deepEqual(seen[2].memory.conversation, []);
    assert.deepEqual(seen[2].memory.preferences, []);
    assert.equal(service.messages().some((m: any) => m.id === message.id), false);
    assert.equal(service.memory.preferences(fixtures[6].project, 'local')[0].value, 'detailed');
    assert.equal(service.memory.preferences(fixtures[0].project, 'another-user')[0].value, 'private');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('new web messages retain earlier records beyond the display window', () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    for (let n = 0; n < 45; n++) service.addMessage({ role: 'user', content: n === 0 ? '오래된 유일표식' : `메시지 ${n}` });
    assert.equal(service.messages().length, 40);
    assert.equal(service.db.get<{ n: number }>('SELECT count(*) AS n FROM messages')?.n, 45);
    assert.ok(service.memory.retrieve(fixtures[0].project, 'local', '유일표식').conversation.some(m => m.content === '오래된 유일표식'));
  } finally { service.close(); }
});
