import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/core.js';

const source = { account: 'mock:primary', project: 'approval-project', externalId: 'thread', revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert' as const, source: 'outlook' as const, details: { subject: 'Request', body: 'Please review the proposal.' } };
const jira = { ...source, externalId: 'J-1', source: 'jira' as const, details: { issueKey: 'J-1', status: 'open', summary: 'Review the proposal.' } };
const local = { kind: 'local' as const, id: 'local' };
async function ready(service: ReturnType<typeof createService>, target = source) {
  const event = service.mockConnectors.ingest(target);
  const created = service.createWorkspaceGoal({ title: 'Review proposal', completion: 'Prepare draft', project: target.project });
  await service.planWorkspaceGoal(created.id, 0);
  service.runWorkspaceGoal(created.id, 1); service.runWorkspaceGoal(created.id, 1);
  const artifact = (service.inspectWorkspaceGoal(created.id).artifacts as any[])[0];
  return { goalId: created.id, artifactId: artifact.id, targetEventId: event.eventId };
}

test('goal approval binds scope, requires owner, supports edit and is idempotent across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-approval-')); const dbPath = join(dir, 'test.sqlite');
  let service = createService({ dbPath, discordOwnerId: 'owner' });
  try {
    const { goalId, artifactId, targetEventId } = await ready(service);
    const approval = service.workspaceApprovals.create(goalId, artifactId, targetEventId);
    assert.equal(service.workspaceApprovals.create(goalId, artifactId, targetEventId).id, approval.id);
    assert.throws(() => service.workspaceApprovals.decide(goalId, approval.id, 'approve', { kind: 'discord', id: 'other' }), /reviewer_not_authorized/);
    assert.equal(service.workspaceApprovals.outcomes(goalId).length, 0);
    const edit = service.workspaceApprovals.decide(goalId, approval.id, 'edit', local, 'Reviewed reply');
    assert.equal(edit.status, 'edited');
    assert.ok(edit.newApprovalId);
    assert.equal(service.workspaceApprovals.decide(goalId, approval.id, 'approve', local).status, 'stale');
    service.close(); service = createService({ dbPath, discordOwnerId: 'owner' });
    assert.equal(service.workspaceApprovals.decide(goalId, edit.newApprovalId!, 'approve', { kind: 'discord', id: 'owner' }).status, 'executed');
    assert.equal(service.workspaceApprovals.decide(goalId, edit.newApprovalId!, 'approve', local).status, 'already_executed');
    const approvals = service.workspaceApprovals.inspect(goalId);
    assert.equal(approvals.find(a => a.id === edit.newApprovalId)?.reviewer, 'discord:owner');
    assert.equal((approvals.find(a => a.id === edit.newApprovalId)?.payload as any).body, 'Reviewed reply');
    assert.equal(service.workspaceApprovals.outcomes(goalId).length, 1);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('approval refuses other projects and stale target, plan, and expiry', async () => {
  for (const scenario of ['target', 'plan', 'expiry', 'tamper-expiry', 'project'] as const) {
    const service = createService({ dbPath: ':memory:' });
    try {
      const x = await ready(service);
      if (scenario === 'project') {
        const other = service.mockConnectors.ingest({ ...source, project: 'other' });
        assert.throws(() => service.workspaceApprovals.create(x.goalId, x.artifactId, other.eventId), /invalid_mock_target/);
        continue;
      }
      const a = service.workspaceApprovals.create(x.goalId, x.artifactId, x.targetEventId);
      if (scenario === 'target') service.mockConnectors.ingest({ ...source, revision: 2, details: { ...source.details, body: 'Changed.' } });
      if (scenario === 'plan') await service.planWorkspaceGoal(x.goalId, 1);
      if (scenario === 'expiry') service.advanceClock('week');
      if (scenario === 'tamper-expiry') service.db.run('UPDATE workspace_approvals SET expires_at=? WHERE id=?', ['2099-01-01T00:00:00Z', a.id]);
      assert.equal(service.workspaceApprovals.inspect(x.goalId)[0].effectiveStatus, scenario === 'expiry' ? 'expired' : 'stale');
      assert.equal(service.workspaceApprovals.decide(x.goalId, a.id, 'approve', local).status, scenario === 'expiry' ? 'expired' : 'stale');
      assert.equal(service.workspaceApprovals.outcomes(x.goalId).length, 0);
    } finally { service.close(); }
  }
});

test('mock Jira write is atomic and rejection or failed effect cannot mutate source', async () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    const x = await ready(service, jira as any);
    const approval = service.workspaceApprovals.create(x.goalId, x.artifactId, x.targetEventId);
    const ingest = service.mockConnectors.ingest;
    service.mockConnectors.ingest = () => { throw new Error('injected_mock_failure'); };
    assert.throws(() => service.workspaceApprovals.decide(x.goalId, approval.id, 'approve', local), /injected_mock_failure/);
    assert.equal(service.workspaceApprovals.inspect(x.goalId)[0].status, 'pending');
    assert.equal(service.workspaceApprovals.outcomes(x.goalId).length, 0);
    assert.equal(service.mockConnectors.query(jira.project, 'jira', jira.account)[0].revision, 1);
    service.mockConnectors.ingest = ingest;
    assert.equal(service.workspaceApprovals.decide(x.goalId, approval.id, 'approve', local).status, 'executed');
    assert.equal(service.mockConnectors.query(jira.project, 'jira', jira.account)[0].revision, 2);
    assert.equal(service.workspaceApprovals.decide(x.goalId, approval.id, 'approve', local).status, 'already_executed');
    assert.equal(service.workspaceApprovals.outcomes(x.goalId).length, 1);
  } finally { service.close(); }
});

test('workspace defer and resume preserve scope, expiry, authorization and goal isolation across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-defer-')), dbPath = join(dir, 'test.sqlite');
  let service = createService({ dbPath, discordOwnerId: 'owner' });
  try {
    const first = await ready(service), second = await ready(service);
    const a = service.workspaceApprovals.create(first.goalId, first.artifactId, first.targetEventId);
    const b = service.workspaceApprovals.create(second.goalId, second.artifactId, second.targetEventId);
    assert.throws(() => service.workspaceApprovals.decide(first.goalId, a.id, 'defer', { kind: 'discord', id: 'other' }), /reviewer_not_authorized/);
    assert.throws(() => service.workspaceApprovals.decide(second.goalId, a.id, 'defer', local), /approval_not_found/);
    assert.equal(service.workspaceApprovals.decide(first.goalId, a.id, 'expire', local).status, 'not_expired');
    assert.equal(service.workspaceApprovals.decide(first.goalId, a.id, 'defer', local).status, 'deferred');
    assert.equal(service.workspaceApprovals.decide(first.goalId, a.id, 'approve', local).status, 'deferred');
    assert.equal(service.workspaceApprovals.inspect(first.goalId)[0].effectiveStatus, 'deferred');
    assert.equal(service.workspaceApprovals.inspect(second.goalId)[0].status, 'pending');
    assert.equal(service.workspaceApprovals.outcomes(first.goalId).length, 0);
    service.close(); service = createService({ dbPath, discordOwnerId: 'owner' });
    assert.equal(service.workspaceApprovals.decide(first.goalId, a.id, 'resume', { kind: 'discord', id: 'owner' }).status, 'pending');
    assert.equal(service.workspaceApprovals.decide(first.goalId, a.id, 'approve', local).status, 'executed');
    assert.equal(service.workspaceApprovals.decide(first.goalId, a.id, 'approve', local).status, 'already_executed');
    assert.equal(service.workspaceApprovals.decide(second.goalId, b.id, 'defer', local).status, 'deferred');
    service.advanceClock('week');
    assert.equal(service.workspaceApprovals.inspect(second.goalId)[0].effectiveStatus, 'expired');
    assert.equal(service.workspaceApprovals.decide(second.goalId, b.id, 'resume', local).status, 'expired');
    assert.equal(service.workspaceApprovals.inspect(second.goalId)[0].status, 'expired');
    assert.equal(service.workspaceApprovals.outcomes(second.goalId).length, 0);
    const audit = service.db.all<{ action: string }>('SELECT action FROM workspace_approval_audit WHERE approval_id=? ORDER BY id', [a.id]).map(r => r.action);
    assert.deepEqual(audit, ['created', 'deferred', 'resumed', 'executed']);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('deferred approval cannot resume after its target changes and may be rejected without execution', async () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    const x = await ready(service), y = await ready(service);
    const a = service.workspaceApprovals.create(x.goalId, x.artifactId, x.targetEventId);
    const b = service.workspaceApprovals.create(y.goalId, y.artifactId, y.targetEventId);
    service.workspaceApprovals.decide(x.goalId, a.id, 'defer', local);
    service.workspaceApprovals.decide(y.goalId, b.id, 'defer', local);
    assert.equal(service.workspaceApprovals.decide(y.goalId, b.id, 'reject', local).status, 'rejected');
    service.mockConnectors.ingest({ ...source, revision: 2, details: { ...source.details, body: 'Changed.' } });
    assert.equal(service.workspaceApprovals.inspect(x.goalId)[0].effectiveStatus, 'stale');
    assert.equal(service.workspaceApprovals.decide(x.goalId, a.id, 'resume', local).status, 'stale');
    assert.equal(service.workspaceApprovals.outcomes(x.goalId).length, 0);
    assert.equal(service.workspaceApprovals.outcomes(y.goalId).length, 0);
  } finally { service.close(); }
});
