import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { j } from './db.js';
import type { createWorkflow } from './workflow.js';
import type { createMockConnectors } from './mockConnectors.js';

export type Reviewer = { kind: 'local' | 'discord'; id: string };
type Workflow = ReturnType<typeof createWorkflow>;
type Connectors = ReturnType<typeof createMockConnectors>;
type Target = { source: 'outlook' | 'jira'; account: string; project: string; external_id: string; revision: number; event_id: number; operation: string; details_json: string; occurred_at: string };
type Approval = { id: string; goal_id: string; plan_version: number; artifact_id: number; target_event_id: number; target_revision: number; action_type: string; payload_json: string; scope_hash: string; status: string; expires_at: string; created_at: string; reviewer: string | null; decided_at: string | null };

function hash(value: unknown) { return createHash('sha256').update(j.str(value)).digest('hex'); }
function addDays(value: string, days: number) { const date = new Date(value); date.setUTCDate(date.getUTCDate() + days); return date.toISOString(); }

export function createWorkspaceApprovals(db: Db, clock: () => string, workflow: Workflow, connectors: Connectors, discordOwnerId?: string, onCreated?: (goalId: string, approvalId: string) => void) {
  function reviewerName(reviewer: Reviewer) {
    if (reviewer.kind === 'local' && reviewer.id === 'local') return 'local';
    if (reviewer.kind === 'discord' && discordOwnerId && reviewer.id === discordOwnerId) return `discord:${reviewer.id}`;
    throw new Error('reviewer_not_authorized');
  }
  function goal(id: string) {
    const row = db.get<{ id: string; current_plan: number; project: string }>('SELECT g.id,g.current_plan,p.project FROM workspace_goals w JOIN workflow_goals g ON g.id=w.goal_id JOIN workflow_goal_projects p ON p.goal_id=g.id WHERE g.id=? AND w.owner=? AND g.owner=?', [id, 'local', 'local']);
    if (!row) throw new Error('workspace_goal_not_found');
    return row;
  }
  function currentPlan(goalId: string, version: number) {
    const g = goal(goalId);
    if (g.current_plan !== version || version < 1) throw new Error('stale_plan');
    if (db.get<{ n: number }>("SELECT count(*) AS n FROM workflow_steps WHERE goal_id=? AND plan_version=? AND status<>'complete'", [goalId, version])!.n) throw new Error('plan_incomplete');
    if (workflow.runNext(goalId, version).status !== 'complete') throw new Error('plan_incomplete');
    return g;
  }
  function targetFor(project: string, targetEventId: number): Target {
    const row = db.get<Target>('SELECT source,account,project,external_id,revision,event_id,operation,details_json,occurred_at FROM mock_connector_events WHERE event_id=? AND project=?', [targetEventId, project]);
    if (!row || !['outlook', 'jira'].includes(row.source) || row.operation !== 'upsert') throw new Error('invalid_mock_target');
    const latest = db.get<{ revision: number }>('SELECT MAX(revision) AS revision FROM mock_connector_events WHERE source=? AND account=? AND project=? AND external_id=?', [row.source, row.account, row.project, row.external_id]);
    if (!latest || row.revision !== latest.revision) throw new Error('stale_target');
    return row;
  }
  function scope(a: Pick<Approval, 'goal_id' | 'plan_version' | 'artifact_id' | 'target_event_id' | 'target_revision' | 'action_type'>, payload: unknown, expiresAt: string) {
    return hash({ goalId: a.goal_id, planVersion: a.plan_version, artifactId: a.artifact_id, targetEventId: a.target_event_id, targetRevision: a.target_revision, actionType: a.action_type, payload, expiresAt });
  }
  function audit(id: string, actor: string, action: string) { db.run('INSERT INTO workspace_approval_audit(approval_id,actor,action,created_at) VALUES(?,?,?,?)', [id, actor, action, clock()]); }
  function publicRow(row: Approval) { return { ...row, payload: j.parse(row.payload_json, null), payload_json: undefined, scope_hash: undefined }; }
  function read(id: string) { return db.get<Approval>('SELECT * FROM workspace_approvals WHERE id=?', [id]); }
  function inspect(goalId: string) {
    goal(goalId);
    return db.all<Approval>('SELECT * FROM workspace_approvals WHERE goal_id=? ORDER BY created_at,id', [goalId]).map(row => { const validity = validate(row); return { ...publicRow(row), effectiveStatus: validity === 'ok' ? row.status : validity }; });
  }
  function targets(goalId: string) {
    const g = goal(goalId);
    return db.all<{ source: string; account: string; external_id: string; revision: number; event_id: number; title: string }>(`SELECT m.source,m.account,m.external_id,m.revision,m.event_id,ev.title FROM mock_connector_events m JOIN events ev ON ev.id=m.event_id
      WHERE m.project=? AND m.source IN ('jira','outlook') AND m.operation='upsert' AND m.revision=(SELECT MAX(x.revision) FROM mock_connector_events x WHERE x.source=m.source AND x.account=m.account AND x.project=m.project AND x.external_id=m.external_id)
      ORDER BY m.source,m.account,m.external_id`, [g.project]).map(row => ({ source: row.source, account: row.account, externalId: row.external_id, revision: row.revision, eventId: row.event_id, title: row.title }));
  }
  function outcomes(goalId: string) {
    goal(goalId);
    return db.all<any>('SELECT e.id,e.approval_id,e.action_type,e.result_json,e.created_at FROM workspace_effects e JOIN workspace_approvals a ON a.id=e.approval_id WHERE a.goal_id=? ORDER BY e.id', [goalId]).map(row => ({ ...row, result: j.parse(row.result_json, null), result_json: undefined }));
  }
  function create(goalId: string, artifactId: number, targetEventId: number) {
    if (!Number.isSafeInteger(artifactId) || !Number.isSafeInteger(targetEventId) || artifactId < 1 || targetEventId < 1) throw new Error('invalid_approval_request');
    return db.tx(() => {
      const g = goal(goalId);
      currentPlan(goalId, g.current_plan);
      const artifact = db.get<{ id: number; content: string; plan_version: number }>('SELECT id,content,plan_version FROM workflow_artifacts WHERE id=? AND goal_id=? AND plan_version=?', [artifactId, goalId, g.current_plan]);
      if (!artifact) throw new Error('artifact_not_found');
      const target = targetFor(g.project, targetEventId);
      const actionType = target.source === 'outlook' ? 'mock_reply' : 'mock_jira_update';
      const payload = target.source === 'outlook'
        ? { account: target.account, project: target.project, thread: target.external_id, targetRevision: target.revision, body: artifact.content }
        : { account: target.account, project: target.project, issue: target.external_id, targetRevision: target.revision, status: 'review-ready', comment: artifact.content };
      return insert({ goal_id: goalId, plan_version: g.current_plan, artifact_id: artifactId, target_event_id: target.event_id, target_revision: target.revision, action_type: actionType }, payload, 'local');
    });
  }
  function insert(base: Pick<Approval, 'goal_id' | 'plan_version' | 'artifact_id' | 'target_event_id' | 'target_revision' | 'action_type'>, payload: unknown, actor: string) {
    const payloadJson = j.str(payload);
    const existing = db.get<Approval>('SELECT * FROM workspace_approvals WHERE goal_id=? AND plan_version=? AND artifact_id=? AND target_event_id=? AND target_revision=? AND action_type=? AND payload_json=? ORDER BY created_at,id LIMIT 1', [base.goal_id, base.plan_version, base.artifact_id, base.target_event_id, base.target_revision, base.action_type, payloadJson]);
    if (existing) return publicRow(existing);
    const expiresAt = addDays(clock(), 2);
    const scopeHash = scope(base, payload, expiresAt);
    const id = `approval-${randomUUID()}`;
    db.run('INSERT INTO workspace_approvals(id,goal_id,plan_version,artifact_id,target_event_id,target_revision,action_type,payload_json,scope_hash,status,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id, base.goal_id, base.plan_version, base.artifact_id, base.target_event_id, base.target_revision, base.action_type, payloadJson, scopeHash, 'pending', expiresAt, clock()]);
    audit(id, actor, 'created');
    onCreated?.(base.goal_id, id);
    return publicRow(read(id)!);
  }
  function validate(a: Approval) {
    if (a.status !== 'pending' && a.status !== 'deferred') return a.status;
    const now = Date.parse(clock()), expires = Date.parse(a.expires_at);
    if (!Number.isFinite(now) || !Number.isFinite(expires)) return 'stale';
    if (now > expires) return 'expired';
    try {
      const g = currentPlan(a.goal_id, a.plan_version);
      const artifact = db.get('SELECT id FROM workflow_artifacts WHERE id=? AND goal_id=? AND plan_version=?', [a.artifact_id, a.goal_id, a.plan_version]);
      const target = targetFor(g.project, a.target_event_id);
      const payload = j.parse<any>(a.payload_json, null);
      if (!artifact || !payload || a.target_revision !== target.revision || scope(a, payload, a.expires_at) !== a.scope_hash) return 'stale';
      if (a.action_type === 'mock_reply' && (target.source !== 'outlook' || payload.account !== target.account || payload.project !== target.project || payload.thread !== target.external_id || payload.targetRevision !== target.revision || typeof payload.body !== 'string')) return 'stale';
      if (a.action_type === 'mock_jira_update' && (target.source !== 'jira' || payload.account !== target.account || payload.project !== target.project || payload.issue !== target.external_id || payload.targetRevision !== target.revision || payload.status !== 'review-ready' || typeof payload.comment !== 'string')) return 'stale';
      if (!['mock_reply', 'mock_jira_update'].includes(a.action_type)) return 'stale';
      return 'ok';
    } catch { return 'stale'; }
  }
  function decide(goalId: string, id: string, decision: 'approve' | 'reject' | 'edit' | 'defer' | 'resume' | 'expire', reviewer: Reviewer, editedText?: unknown) {
    const actor = reviewerName(reviewer);
    if (!['approve', 'reject', 'edit', 'defer', 'resume', 'expire'].includes(decision)) throw new Error('bad_decision');
    return db.tx(() => {
      const a = read(id);
      if (!a || a.goal_id !== goalId) throw new Error('approval_not_found');
      if (a.status === 'executed') return { status: 'already_executed' };
      const valid = validate(a);
      if (valid !== 'ok') {
        if ((valid === 'stale' || valid === 'expired') && ['pending', 'deferred'].includes(a.status)) { db.run('UPDATE workspace_approvals SET status=?,decided_at=? WHERE id=? AND status=?', [valid, clock(), id, a.status]); audit(id, actor, valid); }
        return { status: valid };
      }
      if (decision === 'expire') return { status: 'not_expired' };
      if (decision === 'defer') {
        if (a.status === 'deferred') return { status: 'deferred' };
        db.run("UPDATE workspace_approvals SET status='deferred',reviewer=?,decided_at=? WHERE id=? AND status='pending'", [actor, clock(), id]); audit(id, actor, 'deferred'); return { status: 'deferred' };
      }
      if (decision === 'resume') {
        if (a.status === 'pending') return { status: 'pending' };
        db.run("UPDATE workspace_approvals SET status='pending',reviewer=?,decided_at=? WHERE id=? AND status='deferred'", [actor, clock(), id]); audit(id, actor, 'resumed'); return { status: 'pending' };
      }
      if (decision === 'reject') {
        db.run("UPDATE workspace_approvals SET status='rejected',reviewer=?,decided_at=? WHERE id=? AND status=?", [actor, clock(), id, a.status]); audit(id, actor, 'rejected'); return { status: 'rejected' };
      }
      if (a.status === 'deferred') return { status: 'deferred' };
      if (decision === 'edit') {
        if (typeof editedText !== 'string' || !editedText.trim() || editedText.length > 2000) throw new Error('invalid_edit');
        const payload = j.parse<any>(a.payload_json, {});
        if (a.action_type === 'mock_reply') payload.body = editedText.trim(); else payload.comment = editedText.trim();
        if (j.str(payload) === a.payload_json) throw new Error('unchanged_edit');
        const previous = db.get('SELECT id FROM workspace_approvals WHERE goal_id=? AND plan_version=? AND artifact_id=? AND target_event_id=? AND target_revision=? AND action_type=? AND payload_json=?', [a.goal_id, a.plan_version, a.artifact_id, a.target_event_id, a.target_revision, a.action_type, j.str(payload)]);
        if (previous) throw new Error('duplicate_edit');
        db.run("UPDATE workspace_approvals SET status='stale',reviewer=?,decided_at=? WHERE id=? AND status='pending'", [actor, clock(), id]); audit(id, actor, 'edited');
        const next = insert(a, payload, actor);
        return { status: 'edited', newApprovalId: next.id };
      }
      if (decision !== 'approve') throw new Error('bad_decision');
      const target = targetFor(goal(goalId).project, a.target_event_id);
      const payload = j.parse<any>(a.payload_json, {});
      let result: unknown = { mock: true, target: target.external_id, targetRevision: target.revision };
      if (a.action_type === 'mock_jira_update') {
        const details = j.parse<{ issueKey: string; summary: string; status: string }>(target.details_json, null as any);
        if (!details) throw new Error('invalid_mock_target');
        const changed = connectors.ingest({ source: 'jira', account: target.account, project: target.project, externalId: target.external_id, revision: target.revision + 1, occurredAt: clock(), operation: 'upsert', details: { ...details, status: payload.status } });
        result = { mock: true, target: target.external_id, targetRevision: target.revision, newEventId: changed.eventId, newRevision: target.revision + 1 };
      }
      db.run('INSERT INTO workspace_effects(approval_id,action_type,result_json,created_at) VALUES(?,?,?,?)', [id, a.action_type, j.str(result), clock()]);
      db.run("UPDATE workspace_approvals SET status='executed',reviewer=?,decided_at=? WHERE id=? AND status='pending'", [actor, clock(), id]); audit(id, actor, 'executed');
      return { status: 'executed' };
    });
  }
  function isNotificationEligible(goalId: string, approvalId: string) {
    const row = read(approvalId);
    return !!row && row.goal_id === goalId && row.status === 'pending' && validate(row) === 'ok';
  }
  return { create, decide, inspect, outcomes, targets, isNotificationEligible };
}
