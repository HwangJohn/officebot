import type { Db } from './db.js';
import { j } from './db.js';
import { validateReviewArtifact, type createDurableScheduler, type HandlerContext } from './durableScheduler.js';
import { formatReviewSummary } from './reviewSummary.js';
import { randomUUID } from 'node:crypto';

type Scheduler = ReturnType<typeof createDurableScheduler>;
type EventHandler = (ctx: HandlerContext, eventId: number, checkCurrent: () => void, signal: AbortSignal) => Promise<{ plannedVersion?: number }>;
export function createWorkspaceAutomation(db: Db, scheduler: Scheduler, now: () => number, options: { continueGoal?: EventHandler; handlerTimeoutMs?: number } = {}) {
  const handlerTimeoutMs = options.handlerTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(handlerTimeoutMs) || handlerTimeoutMs < 1 || handlerTimeoutMs >= 60_000) throw new Error('invalid_handler_timeout');
  db.db.exec('CREATE TABLE IF NOT EXISTS workspace_schedule_bindings(goal_id TEXT NOT NULL REFERENCES workflow_goals(id),kind TEXT NOT NULL,schedule_id TEXT NOT NULL,PRIMARY KEY(goal_id,kind),FOREIGN KEY(goal_id,schedule_id) REFERENCES scheduler_schedules(goal_id,schedule_id))');
  // Copy the previous projection once into the scheduler store, without removing
  // historical data. A conflicting row must be reviewed rather than overwritten.
  db.tx(() => {
    const rows = db.all<{ job_id: string; goal_id: string; kind: string; artifact_json: string; approval_status: string; created_at: number }>('SELECT * FROM workspace_empty_reviews');
    for (const row of rows) {
      const artifact = j.parse<any>(row.artifact_json, null);
      const job = db.get<{ goal_id: string; kind: string }>('SELECT goal_id,kind FROM scheduler_jobs WHERE id=?', [row.job_id]);
      try { validateReviewArtifact(artifact); } catch { throw new Error('legacy_review_invalid'); }
      if (!job || job.goal_id !== row.goal_id || job.kind !== row.kind || !['daily_review', 'weekly_review'].includes(row.kind) || row.approval_status !== 'no_action' || artifact.proposals.length !== 0) throw new Error('legacy_review_invalid');
      const old = db.get<typeof row>('SELECT * FROM scheduler_reviews WHERE job_id=?', [row.job_id]);
      if (old && (old.goal_id !== row.goal_id || old.kind !== row.kind || old.artifact_json !== row.artifact_json || old.approval_status !== row.approval_status)) throw new Error('legacy_review_conflict');
      if (!old) db.run('INSERT INTO scheduler_reviews(job_id,goal_id,kind,artifact_json,approval_status,created_at) VALUES(?,?,?,?,?,?)', [row.job_id, row.goal_id, row.kind, row.artifact_json, row.approval_status, row.created_at]);
    }
  });
  function goal(goalId: string) {
    const row = db.get<{ id: string; title: string; project: string }>('SELECT g.id,g.title,p.project FROM workspace_goals w JOIN workflow_goals g ON g.id=w.goal_id JOIN workflow_goal_projects p ON p.goal_id=g.id WHERE g.id=? AND w.owner=? AND g.owner=?', [goalId, 'local', 'local']);
    if (!row) throw new Error('workspace_goal_not_found');
    return row;
  }
  function enqueueEvent(project: string, eventId: number) {
    const goals = db.all<{ id: string }>('SELECT g.id FROM workspace_goals w JOIN workflow_goals g ON g.id=w.goal_id JOIN workflow_goal_projects p ON p.goal_id=g.id WHERE p.project=? AND w.owner=? AND g.owner=?', [project, 'local', 'local']);
    for (const item of goals) scheduler.enqueue({ goalId: item.id, eventId: `event:${eventId}`, kind: 'event', payload: { eventId }, semantics: 'local_idempotent', dueAt: now() });
  }
  function currentSchedule(goalId: string, kind: string) {
    return db.get<{ schedule_id: string; active: number }>(`SELECT s.schedule_id,s.active FROM scheduler_schedules s WHERE s.goal_id=? AND s.schedule_id=COALESCE((SELECT b.schedule_id FROM workspace_schedule_bindings b WHERE b.goal_id=? AND b.kind=?),?)`, [goalId, goalId, kind, kind]);
  }
  function scheduleReview(goalId: string, kind: unknown, firstDueAt: unknown, civil?: unknown, expectedScheduleId?: unknown) {
    goal(goalId);
    if ((kind !== 'daily_review' && kind !== 'weekly_review') || !Number.isSafeInteger(firstDueAt) || Number(firstDueAt) < 0) throw new Error('invalid_review_schedule');
    if (expectedScheduleId !== undefined && (typeof expectedScheduleId !== 'string' || !expectedScheduleId)) throw new Error('invalid_review_schedule');
    return db.tx(() => {
      const current = currentSchedule(goalId, kind);
      if (current && expectedScheduleId === undefined) throw new Error('schedule_already_exists');
      if (expectedScheduleId !== undefined && current?.schedule_id !== expectedScheduleId) throw new Error('stale_schedule');
      if (current?.active) scheduler.cancelSchedule(goalId, current.schedule_id);
      const scheduleId = current ? `${kind}:${randomUUID()}` : kind;
      // Replacing an identity must not produce a second review for an already
      // recorded occurrence, even when the client submits the same due time.
      const lastReview = db.get<{ due: number | null }>('SELECT MAX(j.scheduled_for) AS due FROM scheduler_jobs j JOIN scheduler_reviews r ON r.job_id=j.id WHERE j.goal_id=? AND j.kind=? AND j.schedule_id IS NOT NULL', [goalId, kind]);
      const requested = Number(firstDueAt);
      const interval = kind === 'daily_review' ? 86_400_000 : 7 * 86_400_000;
      const start = lastReview?.due == null || requested > lastReview.due ? requested : civil === undefined ? requested + (Math.floor((lastReview.due - requested) / interval) + 1) * interval : lastReview.due + 1;
      const result = scheduler.schedule({ goalId, scheduleId, kind, payload: {}, semantics: 'local_idempotent', firstDueAt: start, recurrence: kind === 'daily_review' ? 'daily' : 'weekly', civil: civil as import('./civilSchedule.js').CivilSchedule | undefined });
      db.run('INSERT INTO workspace_schedule_bindings(goal_id,kind,schedule_id) VALUES(?,?,?) ON CONFLICT(goal_id,kind) DO UPDATE SET schedule_id=excluded.schedule_id', [goalId, kind, scheduleId]);
      return result;
    });
  }
  function cancelReview(goalId: string, kind: string, expectedScheduleId?: unknown) {
    goal(goalId);
    if (!['daily_review', 'weekly_review'].includes(kind)) throw new Error('invalid_review_schedule');
    return db.tx(() => {
      const current = currentSchedule(goalId, kind);
      if (expectedScheduleId !== undefined && (typeof expectedScheduleId !== 'string' || current?.schedule_id !== expectedScheduleId)) throw new Error('stale_schedule');
      return current ? scheduler.cancelSchedule(goalId, current.schedule_id) : false;
    });
  }
  function inspect(goalId: string) {
    goal(goalId);
    const data = scheduler.inspect(goalId);
    const reviews = (data.reviews as any[]).map(row => ({ ...row, artifact: j.parse(row.artifact_json, null), artifact_json: undefined }));
    const schedules = (data.schedules as any[]).map(row => ({ ...row, current: currentSchedule(goalId, row.kind)?.schedule_id === row.schedule_id }));
    return { ...data, schedules, reviews, activity: db.all<any>('SELECT effect_id,kind,event_id,details_json,created_at FROM workspace_activity WHERE goal_id=? ORDER BY created_at,effect_id', [goalId]).map(row => ({ ...row, details: j.parse(row.details_json, null), details_json: undefined })) };
  }
  async function handle(ctx: HandlerContext, signal: AbortSignal): Promise<{ outcome: 'progress' | 'no_progress' }> {
    const g = goal(ctx.goalId);
    if (ctx.kind === 'event') {
      const eventId = (ctx.payload as any)?.eventId;
      if (!Number.isSafeInteger(eventId) || eventId < 1) throw new Error('invalid_event_reference');
      const checkCurrent = () => {
        if (signal.aborted) throw new Error('event_cancelled');
        const lease = db.get("SELECT id FROM scheduler_jobs WHERE id=? AND goal_id=? AND status='running' AND lease_token=? AND lease_until>?", [ctx.jobId, ctx.goalId, ctx.leaseToken, now()]);
        if (!lease) throw new Error('event_lease_invalid');
        const event = db.get<{ id: number; source: string; source_event_id: string; project: string; kind: string }>('SELECT id,source,source_event_id,project,kind FROM events WHERE id=? AND project=?', [eventId, g.project]);
        if (!event) throw new Error('event_scope_mismatch');
        const mock = db.get<{ source: string; account: string; project: string; external_id: string; revision: number }>('SELECT source,account,project,external_id,revision FROM mock_connector_events WHERE event_id=?', [eventId]);
        if (mock) {
          const latest = db.get<{ revision: number }>('SELECT MAX(revision) AS revision FROM mock_connector_events WHERE source=? AND account=? AND project=? AND external_id=?', [mock.source, mock.account, mock.project, mock.external_id]);
          if (latest?.revision !== mock.revision) throw new Error('event_superseded');
        }
        return event;
      };
      let event: ReturnType<typeof checkCurrent>;
      try { event = db.tx(checkCurrent); } catch (error) {
        if (error instanceof Error && error.message === 'event_superseded') return { outcome: 'no_progress' };
        throw error;
      }
      if (db.get('SELECT effect_id FROM workspace_activity WHERE effect_id=? AND goal_id=?', [ctx.effectId, ctx.goalId])) return { outcome: 'progress' };
      let result: { plannedVersion?: number };
      try { result = options.continueGoal ? await options.continueGoal(ctx, eventId, () => { checkCurrent(); }, signal) : {}; }
      catch (error) {
        if (error instanceof Error && error.message === 'needs_evidence') return { outcome: 'no_progress' };
        throw error;
      }
      return db.tx(() => {
        checkCurrent();
        db.run('INSERT OR IGNORE INTO workspace_activity(effect_id,goal_id,kind,event_id,details_json,created_at) VALUES(?,?,?,?,?,?)', [ctx.effectId, ctx.goalId, result.plannedVersion ? 'goal_replanned' : 'evidence_changed', event.id, j.str({ source: event.source, reference: event.source_event_id, project: event.project, planVersion: result.plannedVersion ?? null }), now()]);
        return { outcome: 'progress' as const };
      });
    }
    if (ctx.kind === 'daily_review' || ctx.kind === 'weekly_review') {
      if (db.get('SELECT job_id FROM scheduler_reviews WHERE job_id=? AND goal_id=?', [ctx.jobId, ctx.goalId])) return { outcome: 'progress' };
      const evidence = db.all<{ id: number; source: string; source_event_id: string; excerpt: string; details_json: string | null }>(`SELECT e.id,e.source,ev.source_event_id,e.excerpt,m.details_json FROM evidence e JOIN events ev ON ev.id=e.event_id LEFT JOIN mock_connector_events m ON m.event_id=ev.id
        WHERE ev.project=? AND e.trusted=1 AND length(trim(e.excerpt))>0 ORDER BY ev.occurred_at DESC,e.id DESC LIMIT 4`, [g.project]);
      if (!evidence.length) return { outcome: 'no_progress' };
      const sources = evidence.map(row => ({ source: row.source, reference: `ev-${row.id}:${row.source_event_id}`, excerpt: row.excerpt }));
      const blocked = evidence.filter(row => row.source === 'jira' && ['blocked', 'delayed'].includes(String(j.parse<any>(row.details_json, {})?.status ?? '').toLowerCase()));
      const artifact = { summary: formatReviewSummary(ctx.kind, g.title, blocked.map(row => `ev-${row.id}:${row.source_event_id}`)), evidence: sources, proposals: blocked.map(row => ({ description: '차단되거나 지연된 Jira 항목의 다음 단계를 검토합니다.', evidenceReferences: [`ev-${row.id}:${row.source_event_id}`] })) };
      scheduler.saveReview(ctx, artifact);
      return { outcome: 'progress' };
    }
    return { outcome: 'no_progress' };
  }
  async function supervised(ctx: HandlerContext) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('handler_timeout')); controller.abort(); }, handlerTimeoutMs); });
      return await Promise.race([handle(ctx, controller.signal), timeout]);
    } finally { if (timer) clearTimeout(timer); }
  }
  return { enqueueEvent, scheduleReview, cancelReview, inspect, tick: () => scheduler.tick(supervised) };
}
