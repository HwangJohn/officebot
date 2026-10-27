import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createService } from '../src/core.js';
import { fixtures } from '../src/fixtures.js';
import { buildServer } from '../src/server.js';

const brokenAdapter = () => ({ prepare: async (id: string) => ({ snapshot: `snap:${id}` }), decide: async () => { throw new Error('mock_resume_failure'); } });
async function ready(s: ReturnType<typeof createService>) { for (const f of fixtures.slice(0, 6)) s.ingest(f); await s.advanceGoal(); }

test('verified absent local mock outcome requires a fresh approval after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-reconcile-')), dbPath = join(dir, 'test.sqlite');
  let s = createService({ dbPath, engine: 'openai', liveAdapterFactory: brokenAdapter });
  try {
    await ready(s);
    const id = s.state().approvals.find((a: any) => a.action_type === 'send_message').id;
    await assert.rejects(s.decide(id, 'approve'), /mock_resume_failure/);
    const preview = s.inspectMockReconciliation(id);
    assert.equal(preview.evidence, 'mock_no_effect');
    assert.throws(() => s.reconcileMockApproval(id, 'wrong'), /stale_reconciliation/);
    s.db.run('INSERT INTO outcomes(action_id,action_type,status,result_json,created_at) VALUES(?,?,?,?,?)', [id, 'send_message', 'success', '{}', '2026-10-27T00:00:00Z']);
    assert.throws(() => s.reconcileMockApproval(id, preview.reviewToken), /stale_reconciliation/);
    const unknown = s.inspectMockReconciliation(id);
    assert.equal(unknown.evidence, 'unresolved');
    assert.equal(s.reconcileMockApproval(id, unknown.reviewToken).status, 'uncertain');
    s.db.run('DELETE FROM outcomes WHERE action_id=?', [id]);
    s.close(); s = createService({ dbPath, engine: 'openai', liveAdapterFactory: brokenAdapter });
    const afterRestart = s.inspectMockReconciliation(id);
    assert.equal(s.reconcileMockApproval(id, afterRestart.reviewToken).status, 'reconciled_no_effect');
    assert.equal(s.state().outcomes.length, 0);
    assert.equal(s.commitApprovedAction(id).status, 'not_authorized');
    assert.equal((await s.decide(id, 'approve')).status, 'reconciled_no_effect');
    const next = await s.advanceGoal();
    const replacement = s.state().approvals.find((a: any) => a.action_type === 'send_message' && a.status === 'pending');
    assert.ok(replacement && replacement.id !== id && next.approvals?.includes(replacement.id));
    assert.equal(s.state().outcomes.length, 0);
    const audit = s.db.get<any>('SELECT * FROM mock_effect_reconciliations WHERE approval_id=?', [id]);
    assert.equal(audit.reviewer, 'local'); assert.equal(audit.resolution, 'reconciled_no_effect');
  } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('reconciliation cannot release an in-flight mock approval', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const liveAdapterFactory = ({ commitApprovedAction }: any) => ({ prepare: async (id: string) => ({ snapshot: `snap:${id}` }), decide: async (id: string, snapshot: string) => { entered(); await gate; commitApprovedAction(id); return { snapshot }; } });
  const s = createService({ dbPath: ':memory:', engine: 'openai', liveAdapterFactory });
  try {
    await ready(s);
    const id = s.state().approvals.find((a: any) => a.action_type === 'send_message').id;
    const pending = s.decide(id, 'approve'); await started;
    assert.equal(s.inspectMockReconciliation(id).status, 'processing');
    assert.throws(() => s.reconcileMockApproval(id, 'anything'), /approval_not_uncertain/);
    release(); assert.equal((await pending).status, 'executed');
    assert.equal(s.state().outcomes.filter((o: any) => o.action_id === id).length, 1);
  } finally { release(); s.close(); }
});

test('explicit local recovery fences an in-flight mock callback in another service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-fence-')), dbPath = join(dir, 'test.sqlite');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const liveAdapterFactory = ({ commitApprovedAction }: any) => ({ prepare: async (id: string) => ({ snapshot: `snap:${id}` }), decide: async (id: string, snapshot: string) => { entered(); await gate; commitApprovedAction(id); return { snapshot }; } });
  const first = createService({ dbPath, engine: 'openai', liveAdapterFactory });
  let second: ReturnType<typeof createService> | undefined;
  try {
    await ready(first);
    const id = first.state().approvals.find((a: any) => a.action_type === 'send_message').id;
    const pending = first.decide(id, 'approve'); await started;
    second = createService({ dbPath });
    const preview = second.inspectMockReconciliation(id);
    assert.equal(preview.evidence, 'recovery_available');
    assert.throws(() => second!.recoverMockProcessing(id, 'wrong'), /stale_mock_recovery/);
    assert.equal(second.recoverMockProcessing(id, preview.recoveryToken).status, 'uncertain');
    assert.equal(second.db.get<any>('SELECT reviewer FROM mock_processing_recoveries WHERE approval_id=?', [id]).reviewer, 'local');
    const after = second.inspectMockReconciliation(id);
    assert.equal(after.evidence, 'mock_no_effect');
    assert.equal(second.reconcileMockApproval(id, after.reviewToken).status, 'reconciled_no_effect');
    release();
    assert.equal((await pending).status, 'reconciled_no_effect');
    assert.equal(first.state().outcomes.length, 0);
    assert.equal(first.commitApprovedAction(id).status, 'not_authorized');
  } finally { release(); second?.close(); first.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a killed mock worker can be explicitly fenced and reconciled after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-crash-')), dbPath = join(dir, 'test.sqlite');
  const child = fork(fileURLToPath(new URL('./helpers/mock-processing-child.ts', import.meta.url)), [dbPath], { execArgv: ['--experimental-sqlite', '--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let service: ReturnType<typeof createService> | undefined;
  try {
    const [message] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('child_exited_before_processing'); }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('child_processing_timeout')), 15_000); timer.unref(); })]);
    const id = (message as { approvalId: string }).approvalId;
    const exited = once(child, 'exit'); child.kill(); await exited;
    service = createService({ dbPath });
    const preview = service.inspectMockReconciliation(id);
    assert.equal(preview.status, 'processing');
    assert.equal(service.recoverMockProcessing(id, preview.recoveryToken).status, 'uncertain');
    const held = service.inspectMockReconciliation(id);
    assert.equal(held.evidence, 'mock_no_effect');
    assert.equal(service.reconcileMockApproval(id, held.reviewToken).status, 'reconciled_no_effect');
    assert.equal(service.state().outcomes.length, 0);
    await service.advanceGoal();
    assert.ok(service.state().approvals.some((a: any) => a.action_type === 'send_message' && a.status === 'pending' && a.id !== id));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); service?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('processing recovery rejects changed and unsupported scopes', async () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    await ready(service);
    const id = service.state().approvals.find((a: any) => a.action_type === 'send_message').id;
    service.db.run("UPDATE approvals SET status='processing',decision_note='approved' WHERE id=?", [id]);
    const preview = service.inspectMockReconciliation(id);
    service.db.run('UPDATE approvals SET expires_at=? WHERE id=?', ['2099-01-01T00:00:00Z', id]);
    assert.throws(() => service.recoverMockProcessing(id, preview.recoveryToken), /stale_mock_recovery/);
    service.db.run('UPDATE approvals SET target=? WHERE id=?', ['real@example.com', id]);
    assert.equal(service.inspectMockReconciliation(id).evidence, 'not_available');
    assert.throws(() => service.recoverMockProcessing(id, preview.recoveryToken), /mock_recovery_unavailable/);
    assert.equal(service.state().outcomes.length, 0);
    assert.equal(service.db.get<any>('SELECT status FROM approvals WHERE id=?', [id]).status, 'processing');
  } finally { service.close(); }
});

test('recorded mock effect can be reconciled but an active approval cannot', async () => {
  const s = createService({ dbPath: ':memory:' });
  try {
    await ready(s);
    const id = s.state().approvals.find((a: any) => a.action_type === 'jira_update').id;
    assert.equal(s.inspectMockReconciliation(id).evidence, 'not_available');
    assert.throws(() => s.reconcileMockApproval(id, 'anything'), /approval_not_uncertain/);
    assert.equal((await s.decide(id, 'approve')).status, 'executed');
    s.db.run("UPDATE approvals SET status='uncertain' WHERE id=?", [id]);
    const preview = s.inspectMockReconciliation(id);
    assert.equal(preview.evidence, 'mock_effect_recorded');
    assert.equal(s.reconcileMockApproval(id, preview.reviewToken).status, 'executed');
    assert.equal(s.state().outcomes.filter((o: any) => o.action_id === id).length, 1);
    assert.equal(s.db.get<any>('SELECT resolution FROM mock_effect_reconciliations WHERE approval_id=?', [id]).resolution, 'executed');
  } finally { s.close(); }
});

test('local reconciliation API rejects cross-origin mutation', async () => {
  const app = buildServer({ dbPath: ':memory:', engine: 'openai', liveAdapterFactory: brokenAdapter });
  try {
    await app.inject({ method: 'POST', url: '/api/ingest-all' });
    await app.inject({ method: 'POST', url: '/api/step' });
    const state = (await app.inject('/api/state')).json();
    const id = state.approvals.find((a: any) => a.action_type === 'send_message').id;
    await app.inject({ method: 'POST', url: `/api/approvals/${id}/decide`, payload: { decision: 'approve' } });
    const preview = (await app.inject(`/api/approvals/${id}/reconciliation`)).json();
    assert.equal(preview.evidence, 'mock_no_effect');
    const denied = await app.inject({ method: 'POST', url: `/api/approvals/${id}/reconciliation`, headers: { origin: 'https://untrusted.example' }, payload: { reviewToken: preview.reviewToken } });
    assert.equal(denied.statusCode, 403);
    const ok = await app.inject({ method: 'POST', url: `/api/approvals/${id}/reconciliation`, payload: { reviewToken: preview.reviewToken } });
    assert.equal(ok.statusCode, 200); assert.equal(ok.json().status, 'reconciled_no_effect');
  } finally { await app.close(); }
});

test('local processing recovery API requires current preview and rejects cross-origin mutation', async () => {
  const app = buildServer({ dbPath: ':memory:' });
  try {
    await app.inject({ method: 'POST', url: '/api/ingest-all' });
    await app.inject({ method: 'POST', url: '/api/step' });
    const id = (await app.inject('/api/state')).json().approvals.find((a: any) => a.action_type === 'send_message').id;
    const rejected = await app.inject({ method: 'POST', url: `/api/approvals/${id}/recovery`, headers: { origin: 'https://untrusted.example' }, payload: { recoveryToken: 'invalid' } });
    assert.equal(rejected.statusCode, 403);
    const notProcessing = await app.inject({ method: 'POST', url: `/api/approvals/${id}/recovery`, payload: { recoveryToken: 'invalid' } });
    assert.equal(notProcessing.statusCode, 400);
    assert.equal((await app.inject('/api/state')).json().outcomes.length, 0);
  } finally { await app.close(); }
});
