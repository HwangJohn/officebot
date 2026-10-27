import type { Db } from './db.js';

export type OverviewOptions = {
  now?: Date;
  engine?: 'offline' | 'openai';
  backgroundScheduler?: boolean;
  discordConfigured?: boolean;
  discordObservation?: { authenticated: true; observedAt: string; state: 'connected' | 'disconnected' };
  temporalEnabled?: boolean;
};

// Only local workspace goals are included, matching /api/goals. Plan completion is not
// a claim that a real-world goal has been achieved.
const goals = `SELECT g.id,g.title,p.project,g.current_plan,
  COUNT(s.step_id) AS total,COALESCE(SUM(s.status='complete'),0) AS completed,
  (SELECT tool FROM workflow_steps n WHERE n.goal_id=g.id AND n.plan_version=g.current_plan AND n.status<>'complete' ORDER BY n.position LIMIT 1) AS next_tool
  FROM workspace_goals w JOIN workflow_goals g ON g.id=w.goal_id
  JOIN workflow_goal_projects p ON p.goal_id=g.id
  LEFT JOIN workflow_steps s ON s.goal_id=g.id AND s.plan_version=g.current_plan
  WHERE w.owner='local' AND g.owner='local' GROUP BY g.id`;

// These are deliberately *known* invalid requests, not a replacement for the full
// approval validator. Memory/policy/evidence/payload validity is checked on decision.
const approvals = `SELECT a.id,a.goal_id,a.status,a.created_at,
 CASE WHEN a.status IN ('stale','expired') THEN 1
 WHEN a.status IN ('pending','deferred') AND (
   COALESCE(julianday(a.expires_at)<julianday(?),1) OR
   g.current_plan<>a.plan_version OR a.plan_version<1 OR
   EXISTS(SELECT 1 FROM workflow_steps s WHERE s.goal_id=a.goal_id AND s.plan_version=a.plan_version AND s.status<>'complete') OR
   NOT EXISTS(SELECT 1 FROM workflow_artifacts x WHERE x.id=a.artifact_id AND x.goal_id=a.goal_id AND x.plan_version=a.plan_version) OR
   NOT EXISTS(SELECT 1 FROM mock_connector_events m WHERE m.event_id=a.target_event_id AND m.project=p.project AND m.operation='upsert' AND m.revision=a.target_revision AND m.revision=(SELECT MAX(z.revision) FROM mock_connector_events z WHERE z.source=m.source AND z.account=m.account AND z.project=m.project AND z.external_id=m.external_id))
 ) THEN 1 ELSE 0 END AS invalid
 FROM workspace_approvals a JOIN workspace_goals w ON w.goal_id=a.goal_id
 JOIN workflow_goals g ON g.id=w.goal_id JOIN workflow_goal_projects p ON p.goal_id=g.id
 WHERE w.owner='local' AND g.owner='local'`;
const clean = (v: unknown, max = 160) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
const count = (v: unknown) => Number(v ?? 0);
const toolName = (v: unknown) => ({ record_fact: '근거 기록', create_artifact: '초안 만들기', wait_for_mock_record: '목업 자료 대기', personal_followup: '개인 후속 작업' } as Record<string, string>)[String(v)] ?? '단계 확인';
const hasTable = (db: Db, name: string) => Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]));

export function buildSystemOverview(db: Db, options: OverviewOptions = {}) {
  const now = options.now ?? new Date();
  const collectedAt = now.toISOString();
  // The existing approval service uses its persisted demo clock, not wall time.
  const approvalClock = db.get<{ value: string }>("SELECT value FROM kv WHERE key='clock'")?.value ?? collectedAt;
  const gs = db.get<any>(`SELECT COUNT(*) total, COALESCE(SUM(current_plan>0 AND total>0 AND completed=total),0) completed FROM (${goals})`)!;
  const goalRows = db.all<any>(`${goals} ORDER BY g.created_at DESC,g.id LIMIT 8`).map(r => ({ id: clean(r.id, 100), title: clean(r.title), project: clean(r.project), plan: count(r.current_plan), completedSteps: count(r.completed), totalSteps: count(r.total), nextStep: !r.current_plan ? '계획 만들기' : r.completed === r.total && r.total > 0 ? '계획 단계 완료' : toolName(r.next_tool) }));
  const ap = db.get<any>(`SELECT COALESCE(SUM(status='pending' AND invalid=0),0) pending, COALESCE(SUM(status='deferred' AND invalid=0),0) deferred, COALESCE(SUM(invalid=1),0) invalid FROM (${approvals})`, [approvalClock])!;
  const approvalRows = db.all<any>(`SELECT id,goal_id,status,invalid FROM (${approvals}) WHERE (status IN ('pending','deferred') OR invalid=1) ORDER BY invalid DESC,created_at DESC,id LIMIT 8`, [approvalClock]).map(r => ({ id: clean(r.id, 100), goalId: clean(r.goal_id, 100), status: r.invalid ? 'invalid' as const : r.status === 'deferred' ? 'deferred' as const : 'pending' as const }));
  const legacySql = `SELECT a.id,a.status,a.created_at, CASE WHEN a.status IN ('stale','expired') THEN 1 WHEN a.status IN ('pending','deferred') AND (COALESCE(julianday(a.expires_at)<julianday(?),1) OR NOT EXISTS (SELECT 1 FROM goals g WHERE g.id='proposal' AND g.task_version=a.task_version)) THEN 1 ELSE 0 END AS invalid FROM approvals a`;
  const legacy = db.get<any>(`SELECT COALESCE(SUM(status IN ('pending','deferred') AND invalid=0),0) pending, COALESCE(SUM(invalid=1),0) invalid FROM (${legacySql})`, [approvalClock])!;
  const legacyRows = db.all<any>(`SELECT id,invalid FROM (${legacySql}) WHERE status IN ('pending','deferred') OR invalid=1 ORDER BY invalid DESC,created_at DESC,id LIMIT 8`, [approvalClock]).map(r => ({ id: clean(r.id, 100), status: r.invalid ? 'invalid' : 'pending' }));
  const hasJobs = hasTable(db, 'scheduler_jobs');
  const jobs = hasJobs ? db.get<any>(`SELECT COALESCE(SUM(j.status='running'),0) running, COALESCE(SUM(j.status='pending' AND j.due_at<=?),0) queued, COALESCE(SUM((j.status='pending' AND j.due_at>?) OR j.status='waiting'),0) waiting, COALESCE(SUM(j.status='failed'),0) failed, COALESCE(SUM(j.status='held'),0) held FROM scheduler_jobs j JOIN workspace_goals w ON w.goal_id=j.goal_id JOIN workflow_goals g ON g.id=w.goal_id WHERE w.owner='local' AND g.owner='local'`, [now.getTime(), now.getTime()])! : {};
  const jobRows = hasJobs ? db.all<any>(`SELECT j.goal_id,j.kind,j.status,j.updated_at FROM scheduler_jobs j JOIN workspace_goals w ON w.goal_id=j.goal_id JOIN workflow_goals g ON g.id=w.goal_id WHERE w.owner='local' AND g.owner='local' AND j.status IN ('failed','held') ORDER BY j.updated_at DESC,j.id LIMIT 8`).map(r => ({ goalId: clean(r.goal_id, 100), kind: clean(r.kind, 40), status: r.status as 'held' | 'failed' })) : [];
  const scheduleCount = hasTable(db, 'scheduler_schedules') ? count(db.get<{ n: number }>("SELECT COUNT(*) n FROM scheduler_schedules s JOIN workspace_goals w ON w.goal_id=s.goal_id JOIN workflow_goals g ON g.id=w.goal_id WHERE s.active=1 AND w.owner='local' AND g.owner='local'")?.n) : 0;
  const schedules = hasTable(db, 'scheduler_schedules') ? db.all<any>(`SELECT s.goal_id,s.kind,s.next_due FROM scheduler_schedules s JOIN workspace_goals w ON w.goal_id=s.goal_id JOIN workflow_goals g ON g.id=w.goal_id WHERE w.owner='local' AND g.owner='local' AND s.active=1 ORDER BY s.next_due,s.goal_id LIMIT 8`).map(r => ({ goalId: clean(r.goal_id, 100), kind: clean(r.kind, 40), dueAt: count(r.next_due) })) : [];
  // An expired or missing sending lease is an uncertain delivery even before recovery runs.
  const hasOutbox = hasTable(db, 'discord_notification_outbox');
  const deliveries = hasOutbox ? db.get<any>(`SELECT COALESCE(SUM(n.status='queued'),0) queued, COALESCE(SUM(n.status='sending' AND n.lease_until>?),0) sending, COALESCE(SUM(n.status='held' OR (n.status='sending' AND (n.lease_until IS NULL OR n.lease_until<=?))),0) held FROM discord_notification_outbox n JOIN workspace_goals w ON w.goal_id=n.goal_id JOIN workflow_goals g ON g.id=w.goal_id WHERE w.owner='local' AND g.owner='local'`, [now.getTime(), now.getTime()])! : {};
  const deliveryRows = hasOutbox ? db.all<any>(`SELECT n.goal_id FROM discord_notification_outbox n JOIN workspace_goals w ON w.goal_id=n.goal_id JOIN workflow_goals g ON g.id=w.goal_id WHERE w.owner='local' AND g.owner='local' AND (n.status='held' OR (n.status='sending' AND (n.lease_until IS NULL OR n.lease_until<=?))) ORDER BY n.updated_at DESC,n.id LIMIT 8`, [now.getTime()]).map(r => ({ goalId: clean(r.goal_id, 100) })) : [];
  const events = db.all<any>(`SELECT e.id,e.source,e.title,e.occurred_at,e.project FROM events e WHERE EXISTS(SELECT 1 FROM workspace_goals w JOIN workflow_goals g ON g.id=w.goal_id JOIN workflow_goal_projects p ON p.goal_id=g.id WHERE w.owner='local' AND g.owner='local' AND p.project=e.project) ORDER BY e.id DESC LIMIT 8`).map(r => ({ id: count(r.id), source: clean(r.source, 40), title: clean(r.title), occurredAt: clean(r.occurred_at, 50), project: clean(r.project) }));
  const artifacts = db.all<any>(`SELECT a.id,a.goal_id,a.kind,a.created_at FROM workflow_artifacts a JOIN workspace_goals w ON w.goal_id=a.goal_id JOIN workflow_goals g ON g.id=w.goal_id WHERE w.owner='local' AND g.owner='local' ORDER BY a.id DESC LIMIT 8`).map(r => ({ id: count(r.id), goalId: clean(r.goal_id, 100), kind: clean(r.kind, 40), createdAt: clean(r.created_at, 50) }));
  const observation = options.discordObservation;
  const age = observation ? now.getTime() - Date.parse(observation.observedAt) : NaN;
  const observed = observation?.authenticated === true && Number.isFinite(age) && age >= 0 && age <= 5 * 60_000;
  return {
    version: 1 as const, collectedAt,
    goals: { active: count(gs.total) - count(gs.completed), completed: count(gs.completed), items: goalRows },
    approvals: { pending: count(ap.pending), deferred: count(ap.deferred), invalid: count(ap.invalid), clock: clean(approvalClock, 50), items: approvalRows },
    legacyApprovals: { pending: count(legacy.pending), invalid: count(legacy.invalid), items: legacyRows },
    jobs: { running: count(jobs.running), queued: count(jobs.queued), waiting: count(jobs.waiting), failed: count(jobs.failed), held: count(jobs.held), attention: jobRows },
    scheduleCount, schedules, events, artifacts, deliveries: { queued: count(deliveries.queued), sending: count(deliveries.sending), held: count(deliveries.held), attention: deliveryRows },
    runtime: { engine: options.engine === 'openai' ? 'openai' as const : 'offline' as const, model: 'unobserved' as const, scheduler: options.backgroundScheduler ? 'configured' as const : 'disabled' as const, temporal: options.temporalEnabled ? 'configured' as const : 'disabled' as const,
      discord: { configured: Boolean(options.discordConfigured), state: observed ? observation!.state : 'unobserved' as const, observedAt: observed ? observation!.observedAt : null }, mockConnectors: ['Teams', 'Outlook', 'Jira', 'Confluence'] }
  };
}
export type SystemOverview = ReturnType<typeof buildSystemOverview>;
