import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { createService } from '../src/core.js';
import { fixtures } from '../src/fixtures.js';
import { buildServer } from '../src/server.js';

function tempDb() { const d = mkdtempSync(join(tmpdir(), 'wa-')); return { path: join(d, 't.sqlite'), clean: () => rmSync(d, { recursive: true, force: true }) }; }
function seeded(extra: any = {}) { const t = tempDb(); const s = createService({ dbPath: t.path, ...extra }); return { ...t, s }; }
async function ready(s: any) { s.ingest(fixtures[0]); s.ingest(fixtures[1]); s.ingest(fixtures[2]); s.ingest(fixtures[3]); s.ingest(fixtures[4]); s.ingest(fixtures[5]); return await s.advanceGoal(); }
function goodOutput(ids: string[]) { return { status: 'success' as const, koreanSummary: '근거 기반 분석입니다.', summaryEvidenceIds: ids.slice(0, 1), observations: [{ text: '수집된 근거가 있습니다.', evidenceIds: ids.slice(0, 1) }], suggestedNextSteps: [{ text: '검토 후 별도 승인 흐름을 진행하세요.', evidenceIds: ids.slice(0, 1) }], missingInformation: [], draftProposal: { title: '검토용 초안', body: '이 초안은 실행하지 않는 제안입니다.', evidenceIds: ids.slice(0, 1) } }; }

test('duplicates are idempotent and duplicate count reflects actual replay attempts', () => { const { s, clean } = seeded(); try { assert.equal(s.state().duplicateCount, 0); assert.equal(s.ingest(fixtures[0]).inserted, true); assert.equal(s.ingest(fixtures[7]).inserted, false); assert.equal(s.state().events.length, 1); assert.equal(s.state().duplicateCount, 1); } finally { s.close(); clean(); } });

test('personal local todo updates automatically within preauthorized scope', () => { const { s, clean } = seeded(); try { s.ingest(fixtures[0]); s.ingest(fixtures[4]); const todo = s.state().todos[0]; assert.equal(todo.scope, 'personal-local'); assert.equal(todo.due_date, '2026-10-29'); assert.equal(s.state().outcomes.length, 0); } finally { s.close(); clean(); } });

test('shared message and Jira actions require approval', async () => { const { s, clean } = seeded(); try { const r = await ready(s); assert.equal(r.status, 'approval_required'); assert.equal(s.state().approvals.filter((a:any)=>a.status==='pending').length, 2); assert.equal(s.state().outcomes.length, 0); } finally { s.close(); clean(); } });

test('server-owned commit refuses pending approvals without explicit user authorization', async () => { const { s, clean } = seeded(); try { await ready(s); const id = s.state().approvals[0].id; assert.equal((s.commitApprovedAction(id) as any).status, 'not_authorized'); assert.equal(s.state().outcomes.length, 0); assert.equal(s.state().approvals.find((a:any)=>a.id===id).status, 'pending'); } finally { s.close(); clean(); } });

test('approval rejects mismatched target, type, version, and malformed expiry without executing', async () => {
  for (const scenario of [
    { type: 'send_message', column: 'target', value: 'person2@example.com' },
    { type: 'jira_update', column: 'target', value: 'OTHER-1' },
    { type: 'send_message', column: 'action_type', value: 'unknown_action' },
    { type: 'send_message', column: 'target_version', value: 9 },
    { type: 'jira_update', column: 'expires_at', value: 'not-a-date' }
  ]) {
    const { s, clean } = seeded();
    try {
      await ready(s);
      const id = s.state().approvals.find((a: any) => a.action_type === scenario.type).id;
      // The columns are fixed test cases, not user-provided SQL identifiers.
      s.db.run(`UPDATE approvals SET ${scenario.column}=? WHERE id=?`, [scenario.value, id]);
      assert.equal((await s.decide(id, 'approve')).status, 'stale');
      assert.equal(s.state().outcomes.length, 0);
    } finally { s.close(); clean(); }
  }
});

test('approval binds the Jira payload version even when the displayed target version matches current state', async () => {
  const { s, clean } = seeded();
  try {
    await ready(s);
    const id = s.state().approvals.find((a: any) => a.action_type === 'jira_update').id;
    s.db.run('UPDATE approvals SET target_version=2 WHERE id=?', [id]);
    const current = s.state().jira;
    s.db.run('UPDATE kv SET value=? WHERE key=?', [JSON.stringify({ ...current, version: 2 }), 'jira']);
    assert.equal((await s.decide(id, 'approve')).status, 'stale');
    assert.equal(s.state().outcomes.length, 0);
  } finally { s.close(); clean(); }
});

test('uncertain SDK outcome stays blocked across restart and later task versions', async () => {
  const t = tempDb();
  let calls = 0;
  const liveAdapterFactory = () => ({ prepare: async (id: string) => ({ snapshot: `snap:${id}` }), decide: async () => { calls++; throw new Error('mock_resume_failure'); } });
  let s = createService({ dbPath: t.path, engine: 'openai', liveAdapterFactory });
  try {
    await ready(s);
    const id = s.state().approvals.find((a: any) => a.action_type === 'send_message').id;
    await assert.rejects(s.decide(id, 'approve'), /mock_resume_failure/);
    assert.equal(s.state().approvals.find((a: any) => a.id === id).status, 'uncertain');
    assert.equal((s.commitApprovedAction(id) as any).status, 'not_authorized');
    assert.equal(s.state().approvals.find((a: any) => a.id === id).status, 'uncertain');
    assert.equal((await s.decide(id, 'approve')).status, 'uncertain');
    assert.equal((await s.decide(id, 'expire')).status, 'uncertain');
    s.ingest({ ...fixtures[4], sourceEventId: 'new-correction', data: { dueDate: '2026-10-28' } });
    assert.ok((await s.advanceGoal()).approvals?.includes(id));
    s.close();
    s = createService({ dbPath: t.path, engine: 'openai', liveAdapterFactory });
    assert.equal((await s.decide(id, 'approve')).status, 'uncertain');
    assert.ok((await s.advanceGoal()).approvals?.includes(id));
    assert.equal(s.state().approvals.filter((a: any) => a.action_type === 'send_message').length, 1);
    assert.equal(s.state().outcomes.length, 0);
    assert.equal(calls, 1);
  } finally { s.close(); t.clean(); }
});

test('concurrent approval cannot clear an in-flight authorization', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const liveAdapterFactory = ({ commitApprovedAction }: any) => ({
    prepare: async (id: string) => ({ snapshot: `snap:${id}` }),
    decide: async (id: string, snapshot: string) => { entered(); await gate; commitApprovedAction(id); return { snapshot }; }
  });
  const { s, clean } = seeded({ engine: 'openai', liveAdapterFactory });
  try {
    await ready(s);
    const id = s.state().approvals.find((a: any) => a.action_type === 'send_message').id;
    const first = s.decide(id, 'approve');
    await started;
    assert.equal((await s.decide(id, 'approve')).status, 'processing');
    assert.equal((await s.decide(id, 'expire')).status, 'processing');
    assert.equal((await s.decide(id, 'edit', { body: 'changed' })).status, 'processing');
    release();
    assert.equal((await first).status, 'executed');
    assert.equal(s.state().outcomes.filter((o: any) => o.action_id === id).length, 1);
  } finally { release(); s.close(); clean(); }
});

test('a confirmed mock commit stays executed if SDK resume later fails', async () => {
  const liveAdapterFactory = ({ commitApprovedAction }: any) => ({
    prepare: async (id: string) => ({ snapshot: `snap:${id}` }),
    decide: async (id: string) => { commitApprovedAction(id); throw new Error('mock_failure_after_commit'); }
  });
  const { s, clean } = seeded({ engine: 'openai', liveAdapterFactory });
  try {
    await ready(s);
    const id = s.state().approvals.find((a: any) => a.action_type === 'send_message').id;
    await assert.rejects(s.decide(id, 'approve'), /mock_failure_after_commit/);
    assert.equal(s.state().approvals.find((a: any) => a.id === id).status, 'executed');
    assert.equal((await s.decide(id, 'approve')).status, 'already_executed');
    assert.equal(s.state().outcomes.filter((o: any) => o.action_id === id).length, 1);
  } finally { s.close(); clean(); }
});

test('rejection and expiry never execute external-effect mock actions', async () => { const { s, clean } = seeded(); try { await ready(s); const a = s.state().approvals; assert.equal((await s.decide(a[0].id, 'reject')).status, 'rejected'); s.advanceClock('week'); assert.equal((await s.decide(a[1].id, 'approve')).status, 'expired'); assert.equal(s.state().outcomes.length, 0); } finally { s.close(); clean(); } });

test('changed deadline invalidates old approval and allows fresh reissue', async () => { const { s, clean } = seeded(); try { s.ingest(fixtures[0]); s.ingest(fixtures[5]); await s.advanceGoal(); const old = s.state().approvals[0].id; s.ingest(fixtures[4]); assert.equal((await s.decide(old, 'approve')).status, 'stale'); await s.advanceGoal(); const fresh = s.state().approvals.find((a:any)=>a.status==='pending' && a.id !== old); assert.ok(fresh); } finally { s.close(); clean(); } });

test('edited approval requires new approval and then executes edited payload', async () => { const { s, clean } = seeded(); try { await ready(s); const old = s.state().approvals.find((a:any)=>a.action_type==='send_message').id; const e = await s.decide(old, 'edit', { body: '사용자가 검토한 수정 본문' }); assert.equal(e.status, 'edited'); assert.ok(e.newApprovalId); assert.equal((await s.decide(old, 'approve')).status, 'stale'); assert.equal((await s.decide(e.newApprovalId, 'approve')).status, 'executed'); const out = s.state().outcomes.find((o:any)=>o.action_id===e.newApprovalId); assert.match(out.result_json, /수정 본문/); } finally { s.close(); clean(); } });

test('duplicate approval consumption does not duplicate outcomes', async () => { const { s, clean } = seeded(); try { await ready(s); const id = s.state().approvals.find((a:any)=>a.action_type==='send_message').id; assert.equal((await s.decide(id, 'approve')).status, 'executed'); assert.equal((await s.decide(id, 'approve')).status, 'already_executed'); assert.equal(s.state().outcomes.filter((o:any)=>o.action_id===id).length, 1); } finally { s.close(); clean(); } });

test('goal is partial until both required actions execute and does not regenerate after complete', async () => { const { s, clean } = seeded(); try { await ready(s); const send = s.state().approvals.find((a:any)=>a.action_type==='send_message').id; const jira = s.state().approvals.find((a:any)=>a.action_type==='jira_update').id; await s.decide(send, 'approve'); assert.notEqual(s.state().goal.status, '완료'); await s.decide(jira, 'approve'); assert.equal(s.state().goal.status, '완료'); const count = s.state().approvals.length; await s.advanceGoal(); assert.equal(s.state().approvals.length, count); } finally { s.close(); clean(); } });

test('completed old task version outcomes do not complete a new task version', async () => { const { s, clean } = seeded(); try { await ready(s); for (const a of s.state().approvals) await s.decide(a.id, 'approve'); assert.equal(s.state().goal.status, '완료'); const oldVersion = s.state().goal.task_version; const newCorrection = { ...fixtures[4], sourceEventId: 'teams-002-new-correction', occurredAt: '2026-10-28T15:00:00+09:00', title: '기한 재정정: 수요일', body: '고객 검토 일정이 다시 당겨져 수요일까지 필요합니다.', data: { ...(fixtures[4].data ?? {}), dueDate: '2026-10-28' } }; assert.equal(s.ingest(newCorrection).inserted, true); assert.ok(s.state().goal.task_version > oldVersion); assert.notEqual(s.state().goal.status, '완료'); await s.advanceGoal(); const fresh = s.state().approvals.filter((a:any)=>a.task_version===s.state().goal.task_version && a.status==='pending'); assert.equal(fresh.length, 2); assert.equal(s.state().goal.status, '승인 대기'); } finally { s.close(); clean(); } });

test('two required actions can be approved in either order without stale sibling', async () => { const { s, clean } = seeded(); try { await ready(s); const jira = s.state().approvals.find((a:any)=>a.action_type==='jira_update').id; const send = s.state().approvals.find((a:any)=>a.action_type==='send_message').id; assert.equal((await s.decide(jira, 'approve')).status, 'executed'); assert.equal((await s.decide(send, 'approve')).status, 'executed'); assert.equal(s.state().outcomes.length, 2); } finally { s.close(); clean(); } });

test('persistent restart restores goal, draft, and pending approval', async () => { const t = tempDb(); let s = createService({ dbPath: t.path }); try { await ready(s); const before = s.state(); s.close(); s = createService({ dbPath: t.path }); const after = s.state(); assert.equal(after.goal.task_version, before.goal.task_version); assert.equal(after.latestDraft.version, before.latestDraft.version); assert.equal(after.approvals.length, 2); } finally { s.close(); t.clean(); } });

test('hostile content is untrusted evidence and cannot redirect progress', () => { const { s, clean } = seeded(); try { const before = s.state().goal.next_step; s.ingest(fixtures[8]); assert.equal(s.state().goal.next_step, before); assert.equal(s.state().evidence[0].trusted, 0); assert.equal(s.state().outcomes.length, 0); assert.equal(s.state().approvals.length, 0); } finally { s.close(); clean(); } });

test('goal waits for quote and resumes when quote arrives', async () => { const { s, clean } = seeded(); try { s.ingest(fixtures[0]); s.ingest(fixtures[1]); assert.equal((await s.advanceGoal()).reason, 'quote'); assert.equal(s.state().goal.status, '회신 대기'); s.ingest(fixtures[5]); assert.equal((await s.advanceGoal()).status, 'approval_required'); } finally { s.close(); clean(); } });

test('invalid fixture, origin policy, React UI route, and API smoke', async () => { const t = tempDb(); const app = buildServer({ dbPath: t.path }); try { let r = await app.inject('/'); assert.equal(r.statusCode, 200); assert.match(r.body, /Officebot/); assert.match(r.body, /id="root"/); r = await app.inject({ method: 'POST', url: '/api/fixtures/99' }); assert.equal(r.statusCode, 400); r = await app.inject({ method: 'POST', url: '/api/ingest-all', headers: { origin: 'null', host: '127.0.0.1:4317' } }); assert.equal(r.statusCode, 403); r = await app.inject({ method: 'POST', url: '/api/ingest-all', headers: { origin: 'http://localhost:9999', host: 'localhost:4317' } }); assert.equal(r.statusCode, 403); r = await app.inject({ method: 'POST', url: '/api/ingest-all', headers: { origin: 'http://127.0.0.1:4317', host: '127.0.0.1:4317' } }); assert.equal(r.statusCode, 200); r = await app.inject({ method: 'POST', url: '/api/clock/advance', payload: { kind: 'day' } }); assert.equal(r.statusCode, 200); r = await app.inject('/api/state'); const body = r.json(); assert.ok(body.digests.length >= 1); assert.equal(body.mode, 'offline'); assert.equal(body.sdk_snapshots, undefined); } finally { await app.close(); t.clean(); } });

test('inline browser script parses and preserves requested analysis after refresh', () => { const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8'); const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]); assert.ok(scripts.length >= 1); scripts.forEach((script, i) => assert.doesNotThrow(() => new Script(script, { filename: `inline-${i}.js` }))); assert.match(scripts.join('\n'), /renderAnalysis\(r\);\s*await load\(\{preserveAnalysis:true\}\)/); assert.match(scripts.join('\n'), /표시 목표/); assert.match(scripts.join('\n'), /인용 출처/); });

test('openai HTTP routes use injected SDK adapter factory and fake tool commit without paid network', async () => { const t = tempDb(); let prepared = 0, resumed = 0; const liveAdapterFactory = ({ commitApprovedAction }: any) => ({ prepare: async (id: string) => { prepared++; return { snapshot: `snap:${id}`, meta: { mocked: true } }; }, decide: async (id: string, snap: string, approve: boolean) => { resumed++; assert.equal(approve, true); assert.match(snap, new RegExp(id)); if (approve) commitApprovedAction(id); return { snapshot: `done:${id}`, meta: { mocked: true, responses: [{ responseId: 'fake-response', usage: { totalTokens: 1 } }] } }; } }); const app = buildServer({ dbPath: t.path, engine: 'openai', liveAdapterFactory }); try { await app.inject({ method: 'POST', url: '/api/ingest-all' }); await app.inject({ method: 'POST', url: '/api/step' }); assert.equal(prepared, 2); const st = (await app.inject('/api/state')).json(); const id = st.approvals.find((a:any)=>a.action_type==='send_message').id; const r = await app.inject({ method: 'POST', url: `/api/approvals/${id}/decide`, payload: { decision: 'approve' } }); assert.equal(r.statusCode, 200); assert.equal(resumed, 1); assert.equal((await app.inject('/api/state')).json().outcomes.length, 1); } finally { await app.close(); t.clean(); } });

test('analysis HTTP validates nonempty oversized and invalid bodies', async () => { const t = tempDb(); const app = buildServer({ dbPath: t.path }); try { let r = await app.inject({ method: 'POST', url: '/api/analyze', payload: {} }); assert.equal(r.statusCode, 400); r = await app.inject({ method: 'POST', url: '/api/analyze', payload: { goalText: '' } }); assert.equal(r.statusCode, 400); r = await app.inject({ method: 'POST', url: '/api/analyze', payload: { goalText: 'x'.repeat(1001) } }); assert.equal(r.statusCode, 400); } finally { await app.close(); t.clean(); } });

test('analysis HTTP returns fixed helpful errors for bad goal and context retry', async () => { const t = tempDb(); let release!: () => void; let entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; }); const app = buildServer({ dbPath: t.path, analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_g: string, ctx: any) => { entered(); await gate; return { output: goodOutput(ctx.evidence.map((e:any)=>e.id)) }; } }) }); try { let r = await app.inject({ method: 'POST', url: '/api/analyze', payload: { goalText: ' '.repeat(1001) } }); assert.equal(r.statusCode, 400); assert.equal(r.json().error, '분석 목표를 1자 이상 1000자 이하로 입력해 주세요.'); await app.inject({ method: 'POST', url: '/api/fixtures/0' }); const pending = app.inject({ method: 'POST', url: '/api/analyze', payload: { goalText: '느린 분석' } }); await started; await app.inject({ method: 'POST', url: '/api/fixtures/2' }); release(); r = await pending; assert.equal(r.statusCode, 400); assert.equal(r.json().error, '업무 맥락이 분석 중 변경되었습니다. 최신 상태를 다시 불러온 뒤 다시 시도해 주세요.'); } finally { await app.close(); t.clean(); } });

test('analysis with no evidence returns needs_evidence without adapter call', async () => { let calls = 0; const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async () => { calls++; throw new Error('should_not_call'); } }) }); try { const r = await s.analyzeGoal('제안서 목표를 분석해줘'); assert.equal(r.output.status, 'needs_evidence'); assert.equal(calls, 0); assert.equal(s.state().approvals.length, 0); assert.equal(s.state().outcomes.length, 0); } finally { s.close(); clean(); } });

test('analysis selects only trusted current-project evidence', async () => { let seen: any; const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_goal: string, ctx: any) => { seen = ctx; return { output: goodOutput(ctx.evidence.map((e:any)=>e.id)), meta: { mocked: true } }; } }) }); try { s.ingestAll(); const r = await s.analyzeGoal('근거를 보고 초안 제안'); assert.equal(r.output.status, 'success'); assert.ok(seen.evidence.length >= 6); assert.equal(seen.evidence.some((e:any)=>e.sourceEventId === 'teams-004'), false); assert.equal(seen.evidence.some((e:any)=>e.sourceEventId === 'conf-evil-001'), false); } finally { s.close(); clean(); } });

test('analysis uses most recent bounded evidence and full trusted revision for staleness', async () => { const seen: any[] = []; const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_goal: string, ctx: any) => { seen.push(ctx); return { output: goodOutput(ctx.evidence.map((e:any)=>e.id)), meta: { mocked: true } }; } }) }); try { s.ingest(fixtures[0]); for (let i = 0; i < 13; i++) s.ingest({ source: 'confluence', sourceEventId: `policy-${i}`, occurredAt: `2026-10-27T12:${String(i).padStart(2, '0')}:00+09:00`, project: fixtures[0].project, threadId: 'policy-page', actor: '문서봇', kind: 'policy', title: `정책 업데이트 ${i}`, body: `정책 본문 ${i}` }); const first = await s.analyzeGoal('최신 정책 확인'); const firstSeen = seen[0]!; assert.equal(first.stale, false); assert.equal(firstSeen.evidence.length, 12); assert.equal(firstSeen.evidence.some((e:any)=>e.sourceEventId === 'policy-0'), false); assert.equal(firstSeen.evidence.some((e:any)=>e.sourceEventId === 'policy-12'), true); const version = s.state().goal.task_version; s.ingest({ source: 'confluence', sourceEventId: 'policy-new', occurredAt: '2026-10-27T13:30:00+09:00', project: fixtures[0].project, threadId: 'policy-page', actor: '문서봇', kind: 'policy', title: '최신 정책 업데이트', body: '새 정책 본문' }); const staleAfterNew: any = s.state().latestAnalysis; assert.ok(staleAfterNew); assert.equal(s.state().goal.task_version, version); assert.equal(staleAfterNew.stale, true); await s.analyzeGoal('최신 정책 확인'); const secondSeen = seen[1]!; assert.equal(secondSeen.evidence.some((e:any)=>e.sourceEventId === 'policy-new'), true); s.ingest({ source: 'confluence', sourceEventId: 'policy-old-excluded', occurredAt: '2026-10-27T09:01:00+09:00', project: fixtures[0].project, threadId: 'policy-page', actor: '문서봇', kind: 'policy', title: '과거 정책 보강', body: '선택 윈도우 밖의 과거 정책' }); const staleAfterOld: any = s.state().latestAnalysis; assert.ok(staleAfterOld); assert.equal(staleAfterOld.stale, true); await s.analyzeGoal('최신 정책 확인'); const thirdSeen = seen[2]!; assert.equal(thirdSeen.evidence.some((e:any)=>e.sourceEventId === 'policy-old-excluded'), false); } finally { s.close(); clean(); } });

test('analysis rejects unknown citations and uncited substantive output', async () => { const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async () => ({ output: { status: 'success', koreanSummary: '인용 없음', summaryEvidenceIds: [], observations: [{ text: '주장', evidenceIds: [] }], suggestedNextSteps: [], missingInformation: [], draftProposal: { title: 't', body: 'body', evidenceIds: ['ev-999'] } } }) }) }); try { s.ingest(fixtures[0]); await assert.rejects(() => s.analyzeGoal('검증'), /missing_citation|unknown_evidence/); assert.equal(s.state().latestAnalysis, undefined); } finally { s.close(); clean(); } });

test('analysis rejects empty success from fake adapter', async () => { const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_g: string, ctx: any) => ({ output: { status: 'success', koreanSummary: '', summaryEvidenceIds: ctx.evidence.slice(0, 1).map((e:any)=>e.id), observations: [], suggestedNextSteps: [], missingInformation: [], draftProposal: { title: '빈 초안', body: '', evidenceIds: ctx.evidence.slice(0, 1).map((e:any)=>e.id) } } }) }) }); try { s.ingest(fixtures[0]); await assert.rejects(() => s.analyzeGoal('빈 성공 검증'), /empty_success/); assert.equal(s.state().latestAnalysis, undefined); } finally { s.close(); clean(); } });

test('analysis rejects uncited needs_evidence claims when server evidence exists', async () => { const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async () => ({ output: { status: 'needs_evidence', koreanSummary: '근거가 있는데도 주장합니다.', summaryEvidenceIds: [], observations: [], suggestedNextSteps: [], missingInformation: ['더 필요함'], draftProposal: { title: '', body: '', evidenceIds: [] } } }) }) }); try { s.ingest(fixtures[0]); await assert.rejects(() => s.analyzeGoal('needs evidence 검증'), /missing_citation:summary/); assert.equal(s.state().latestAnalysis, undefined); } finally { s.close(); clean(); } });

test('analysis rejects unknown reference from fake adapter', async () => { const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async () => ({ output: { status: 'success', koreanSummary: '알 수 없는 근거를 인용합니다.', summaryEvidenceIds: ['ev-999'], observations: [], suggestedNextSteps: [], missingInformation: [], draftProposal: { title: '검토용 초안', body: '본문', evidenceIds: ['ev-999'] } } }) }) }); try { s.ingest(fixtures[0]); await assert.rejects(() => s.analyzeGoal('알 수 없는 참조 검증'), /unknown_evidence_id/); assert.equal(s.state().latestAnalysis, undefined); } finally { s.close(); clean(); } });

test('deterministic offline analysis succeeds without key and never changes workflow state', async () => { const old = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY; const { s, clean } = seeded(); try { s.ingest(fixtures[0]); s.ingest(fixtures[1]); const before = s.state(); const r = await s.analyzeGoal('견적 대기 상태에서 무엇을 해야 해?'); assert.equal(r.engine, 'offline-mock'); assert.equal(r.source, 'offline'); assert.match(r.output.koreanSummary, /2026-10-30/); assert.match(r.output.koreanSummary, /견적 회신을 기다리고/); const after = s.state(); assert.equal(after.approvals.length, before.approvals.length); assert.equal(after.outcomes.length, before.outcomes.length); assert.equal(after.goal.task_version, before.goal.task_version); } finally { if (old) process.env.OPENAI_API_KEY = old; s.close(); clean(); } });

test('identical analysis request is cached across restart', async () => { const t = tempDb(); let calls = 0; let s = createService({ dbPath: t.path, analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_g: string, ctx: any) => { calls++; return { output: goodOutput(ctx.evidence.map((e:any)=>e.id)) }; } }) }); try { s.ingest(fixtures[0]); const first = await s.analyzeGoal('같은 목표'); assert.equal(first.source, 'live'); s.close(); s = createService({ dbPath: t.path, analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_g: string, ctx: any) => { calls++; return { output: goodOutput(ctx.evidence.map((e:any)=>e.id)) }; } }) }); const second = await s.analyzeGoal('같은   목표'); assert.equal(second.source, 'cached'); assert.equal(second.id, first.id); assert.equal(calls, 1); } finally { s.close(); t.clean(); } });

test('cached analysis response remains tied to requested normalized goal', async () => { let calls = 0; const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_g: string, ctx: any) => { calls++; return { output: goodOutput(ctx.evidence.map((e:any)=>e.id)) }; } }) }); try { s.ingest(fixtures[0]); const first = await s.analyzeGoal('목표 A'); const second = await s.analyzeGoal('목표 B'); const cached = await s.analyzeGoal('목표   A'); const latest: any = s.state().latestAnalysis; assert.ok(latest); assert.equal(cached.source, 'cached'); assert.equal(cached.id, first.id); assert.equal(cached.normalizedGoal, '목표 A'); assert.notEqual(cached.id, second.id); assert.equal(latest.normalizedGoal, '목표 B'); assert.equal(calls, 2); } finally { s.close(); clean(); } });

test('persisted analysis exposes original evidence snapshot, not current rows', async () => { const { s, clean } = seeded(); try { s.ingest(fixtures[0]); const r = await s.analyzeGoal('스냅샷 확인'); assert.ok(r.evidenceSources.length >= 1); assert.equal(r.evidenceSources[0]!.title, fixtures[0].title); s.db.run('UPDATE evidence SET title=?, excerpt=? WHERE id=1', ['바뀐 현재 제목', '바뀐 현재 본문']); const st = s.state(); const latest: any = st.latestAnalysis; assert.ok(latest); assert.equal(latest.evidenceSources[0].title, fixtures[0].title); assert.equal(latest.evidenceSources[0].excerpt, fixtures[0].body.slice(0, 240)); assert.equal((st.evidence[0] as any).title, '바뀐 현재 제목'); assert.equal(latest.stale, true); } finally { s.close(); clean(); } });

test('concurrent identical analysis calls coalesce', async () => { let calls = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_g: string, ctx: any) => { calls++; await gate; return { output: goodOutput(ctx.evidence.map((e:any)=>e.id)) }; } }) }); try { s.ingest(fixtures[0]); const a = s.analyzeGoal('동시 요청'); const b = s.analyzeGoal('동시 요청'); release(); const [ra, rb] = await Promise.all([a, b]); assert.equal(calls, 1); assert.equal(ra.id, rb.id); } finally { s.close(); clean(); } });

test('analysis becomes stale after policy evidence change without task version bump', async () => { const { s, clean } = seeded(); try { s.ingest(fixtures[0]); const r = await s.analyzeGoal('정책 근거 확인'); assert.equal(r.stale, false); const version = s.state().goal.task_version; s.ingest(fixtures[2]); const st = s.state(); assert.equal(st.goal.task_version, version); assert.ok(st.latestAnalysis); assert.equal(st.latestAnalysis.stale, true); } finally { s.close(); clean(); } });

test('in-flight context change rejects response before save', async () => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const { s, clean } = seeded({ analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_g: string, ctx: any) => { await gate; return { output: goodOutput(ctx.evidence.map((e:any)=>e.id)) }; } }) }); try { s.ingest(fixtures[0]); const p = s.analyzeGoal('느린 분석'); s.ingest(fixtures[2]); release(); await assert.rejects(() => p, /analysis_context_changed/); assert.equal(s.state().latestAnalysis, undefined); } finally { s.close(); clean(); } });

test('analysis adapter failure is sanitized over HTTP and leaves approvals/outcomes unchanged', async () => { const t = tempDb(); const app = buildServer({ dbPath: t.path, analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async () => { throw new Error('raw upstream secret-ish detail'); } }) }); try { await app.inject({ method: 'POST', url: '/api/fixtures/0' }); const before = (await app.inject('/api/state')).json(); const r = await app.inject({ method: 'POST', url: '/api/analyze', payload: { goalText: '실패 테스트' } }); assert.equal(r.statusCode, 400); assert.equal(r.json().error, '요청 처리 실패'); const after = (await app.inject('/api/state')).json(); assert.equal(after.approvals.length, before.approvals.length); assert.equal(after.outcomes.length, before.outcomes.length); assert.equal(after.latestAnalysis, undefined); } finally { await app.close(); t.clean(); } });

test('malicious evidence remains data in React UI path and analysis cannot call business commit', async () => { const t = tempDb(); let analyzed = 0; const app = buildServer({ dbPath: t.path, analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_g: string, ctx: any) => { analyzed++; return { output: goodOutput(ctx.evidence.map((e:any)=>e.id)) }; } }) }); try { await app.inject({ method: 'POST', url: '/api/fixtures/8' }); let st = (await app.inject('/api/state')).json(); assert.equal(st.evidence[0].trusted, 0); assert.equal(st.approvals.length, 0); assert.equal(st.outcomes.length, 0); const html = (await app.inject('/')).body; assert.match(html, /id="root"/); assert.doesNotMatch(html, /conf-evil-001/); await app.inject({ method: 'POST', url: '/api/fixtures/0' }); const r = await app.inject({ method: 'POST', url: '/api/analyze', payload: { goalText: '<img src=x onerror=alert(1)> 분석' } }); assert.equal(r.statusCode, 200); st = (await app.inject('/api/state')).json(); assert.equal(analyzed, 1); assert.equal(st.approvals.length, 0); assert.equal(st.outcomes.length, 0); assert.equal(st.latestDraft, undefined); } finally { await app.close(); t.clean(); } });

test('openai analysis route can use injected analyst adapter and missing live key is enforced otherwise', async () => { const old = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY; const t = tempDb(); const liveAdapterFactory = () => ({ prepare: async () => ({ snapshot: 'x' }), decide: async () => ({ snapshot: 'x' }) }); const app = buildServer({ dbPath: t.path, engine: 'openai', liveAdapterFactory, analystAdapterFactory: () => ({ engine: 'openai-agents', analyze: async (_g: string, ctx: any) => ({ output: goodOutput(ctx.evidence.map((e:any)=>e.id)), meta: { mocked: true } }) }) }); try { await app.inject({ method: 'POST', url: '/api/fixtures/0' }); const r = await app.inject({ method: 'POST', url: '/api/analyze', payload: { goalText: '라이브 모드 주입 테스트' } }); assert.equal(r.statusCode, 200); assert.equal(r.json().engine, 'openai-agents'); assert.throws(() => buildServer({ dbPath: join(t.path, 'bad'), engine: 'openai' }), /OPENAI_API_KEY/); } finally { await app.close(); if (old) process.env.OPENAI_API_KEY = old; t.clean(); } });
