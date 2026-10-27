import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { firstCivilOccurrence, latestCivilOccurrence, nextCivilOccurrence, validateCivilSchedule, type CivilSchedule } from './civilSchedule.js';

/** All timestamps are Unix milliseconds; civil recurrence is explicit and opt-in. */
export type JobKind = 'event' | 'daily_review' | 'weekly_review' | 'notification';
/** Idempotent means the handler durably deduplicates *all* effects using effectId, including across concurrent leases. */
export type EffectSemantics = 'local_idempotent' | 'external_unknown';
export type JobInput = { goalId: string; kind: JobKind; payload: unknown; semantics: EffectSemantics; maxAttempts?: number };
export type ScheduleInput = JobInput & { scheduleId: string; firstDueAt: number; recurrence: 'daily' | 'weekly'; civil?: CivilSchedule };
export type EventInput = JobInput & { eventId: string; dueAt: number; coalesceKey?: string };
export type HandlerContext = {
  jobId: string; runId: string; effectId: string; leaseToken: string; leaseUntil: number;
  goalId: string; kind: JobKind; payload: unknown; eventIds: string[]; attempt: number; scheduledFor: number;
};
export type Handler = (context: HandlerContext) => Promise<{ outcome: 'progress' | 'no_progress' }>;
export type ReviewArtifact = { summary: string; evidence: Array<{ source: string; reference: string; excerpt: string }>; proposals: Array<{ description: string; evidenceReferences: string[] }> };
export type SchedulerOptions = { now: () => number; leaseMs?: number; maxPerTick?: number; maxAttempts?: number; retryBaseMs?: number; retryMaxMs?: number; maxStartsPerGoalPerUtcDay?: number };

type JobRow = { id: string; goal_id: string; kind: JobKind; payload_json: string; semantics: EffectSemantics; status: string; due_at: number; scheduled_for: number; attempts: number; max_attempts: number; lease_token: string | null; lease_until: number | null; coalesce_key: string | null; reason: string | null };
type ScheduleRow = { goal_id: string; schedule_id: string; kind: JobKind; payload_json: string; semantics: EffectSemantics; max_attempts: number; next_due: number; interval_ms: number };
const DAY = 86_400_000;
const validText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2000;
function integer(v: number, min: number, max: number, name: string) { if (!Number.isSafeInteger(v) || v < min || v > max) throw new Error(`invalid_${name}`); return v; }
function json(v: unknown) { const s = JSON.stringify(v); if (s === undefined || s.length > 100_000) throw new Error('invalid_payload'); return s; }
export function validateReviewArtifact(value: unknown): asserts value is ReviewArtifact {
  const artifact = value as ReviewArtifact;
  if (!artifact || !validText(artifact.summary) || !Array.isArray(artifact.evidence) || !artifact.evidence.length || !artifact.evidence.every(e => validText(e?.source) && validText(e?.reference) && validText(e?.excerpt)) || !Array.isArray(artifact.proposals) || !artifact.proposals.every(p => validText(p?.description) && Array.isArray(p?.evidenceReferences) && p.evidenceReferences.length > 0 && p.evidenceReferences.every(ref => artifact.evidence.some(e => e.reference === ref)))) throw new Error('invalid_review_artifact');
}

/**
 * Persistent queue on the caller's Db. No background timer is started; the host drives tick().
 * Handlers must honor their semantics and use effectId for durable deduplication. A lease is
 * not an external-write fence. Unknown external outcomes are held for explicit reconciliation.
 */
export function createDurableScheduler(db: Db, options: SchedulerOptions) {
  const leaseMs = integer(options.leaseMs ?? 60_000, 1, DAY, 'lease');
  const maxPerTick = integer(options.maxPerTick ?? 20, 1, 1000, 'tick_limit');
  const defaultAttempts = integer(options.maxAttempts ?? 3, 1, 100, 'attempts');
  const base = integer(options.retryBaseMs ?? 1000, 1, DAY, 'retry_base');
  const maxBackoff = integer(options.retryMaxMs ?? 3_600_000, base, 30 * DAY, 'retry_max');
  const dailyLimit = integer(options.maxStartsPerGoalPerUtcDay ?? 100, 1, 100_000, 'daily_limit');
  const now = () => integer(options.now(), 0, Number.MAX_SAFE_INTEGER - 30 * DAY, 'clock');
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_schedules(goal_id TEXT NOT NULL REFERENCES workflow_goals(id), schedule_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, semantics TEXT NOT NULL, max_attempts INTEGER NOT NULL, next_due INTEGER NOT NULL, interval_ms INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(goal_id,schedule_id));
    CREATE TABLE IF NOT EXISTS scheduler_civil_schedules(goal_id TEXT NOT NULL, schedule_id TEXT NOT NULL, time_zone TEXT NOT NULL, minute_of_day INTEGER NOT NULL, recurrence TEXT NOT NULL, weekday INTEGER NOT NULL, PRIMARY KEY(goal_id,schedule_id), FOREIGN KEY(goal_id,schedule_id) REFERENCES scheduler_schedules(goal_id,schedule_id));
    CREATE TABLE IF NOT EXISTS scheduler_jobs(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workflow_goals(id), kind TEXT NOT NULL, payload_json TEXT NOT NULL, semantics TEXT NOT NULL, status TEXT NOT NULL, due_at INTEGER NOT NULL, scheduled_for INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER, coalesce_key TEXT, schedule_id TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(goal_id,schedule_id,scheduled_for));
    CREATE INDEX IF NOT EXISTS scheduler_due ON scheduler_jobs(status,due_at);
    CREATE TABLE IF NOT EXISTS scheduler_events(goal_id TEXT NOT NULL REFERENCES workflow_goals(id), event_id TEXT NOT NULL, input_json TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES scheduler_jobs(id), PRIMARY KEY(goal_id,event_id));
    CREATE TABLE IF NOT EXISTS scheduler_runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES scheduler_jobs(id), goal_id TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL, UNIQUE(job_id,attempt));
    CREATE INDEX IF NOT EXISTS scheduler_run_budget ON scheduler_runs(goal_id,started_at);
    CREATE TABLE IF NOT EXISTS scheduler_reviews(job_id TEXT PRIMARY KEY REFERENCES scheduler_jobs(id), goal_id TEXT NOT NULL, kind TEXT NOT NULL, artifact_json TEXT NOT NULL, approval_status TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduler_reconciliations(id INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES scheduler_jobs(id), resolution TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduler_cancelled_holds(job_id TEXT PRIMARY KEY REFERENCES scheduler_jobs(id), cancelled_at INTEGER NOT NULL);
  `);
  function validate(input: JobInput) {
    if (!validText(input.goalId) || !['event', 'daily_review', 'weekly_review', 'notification'].includes(input.kind) || !['local_idempotent', 'external_unknown'].includes(input.semantics)) throw new Error('invalid_job');
    if (!db.get('SELECT id FROM workflow_goals WHERE id=?', [input.goalId])) throw new Error('goal_not_found');
    return { payload: json(input.payload), attempts: integer(input.maxAttempts ?? defaultAttempts, 1, 100, 'attempts') };
  }
  function schedule(input: ScheduleInput) {
    const { payload, attempts } = validate(input);
    if (!validText(input.scheduleId) || !['daily', 'weekly'].includes(input.recurrence)) throw new Error('invalid_schedule');
    integer(input.firstDueAt, 0, Number.MAX_SAFE_INTEGER - 30 * DAY, 'due');
    if (input.civil !== undefined) validateCivilSchedule(input.civil);
    const civil = input.civil ? firstCivilOccurrence(input.firstDueAt, input.recurrence, input.civil) : undefined;
    const interval = input.recurrence === 'daily' ? DAY : 7 * DAY;
    return db.tx(() => {
      const existing = db.get<ScheduleRow & { active: number }>('SELECT * FROM scheduler_schedules WHERE goal_id=? AND schedule_id=?', [input.goalId, input.scheduleId]);
      if (existing) {
        throw new Error('schedule_already_exists');
      }
      db.run('INSERT INTO scheduler_schedules(goal_id,schedule_id,kind,payload_json,semantics,max_attempts,next_due,interval_ms) VALUES(?,?,?,?,?,?,?,?)', [input.goalId, input.scheduleId, input.kind, payload, input.semantics, attempts, civil?.dueAt ?? input.firstDueAt, interval]);
      if (civil && input.civil) db.run('INSERT INTO scheduler_civil_schedules(goal_id,schedule_id,time_zone,minute_of_day,recurrence,weekday) VALUES(?,?,?,?,?,?)', [input.goalId, input.scheduleId, input.civil.timeZone, input.civil.minuteOfDay, input.recurrence, civil.weekday]);
      return { goalId: input.goalId, scheduleId: input.scheduleId };
    });
  }
  function enqueue(input: EventInput) {
    const { payload, attempts } = validate(input);
    if (!validText(input.eventId) || (input.coalesceKey !== undefined && !validText(input.coalesceKey))) throw new Error('invalid_event');
    integer(input.dueAt, 0, Number.MAX_SAFE_INTEGER - 30 * DAY, 'due');
    const signature = json({ kind: input.kind, payload: input.payload, semantics: input.semantics, maxAttempts: attempts, dueAt: input.dueAt, coalesceKey: input.coalesceKey ?? null });
    return db.tx(() => {
      const prior = db.get<{ input_json: string; job_id: string }>('SELECT input_json,job_id FROM scheduler_events WHERE goal_id=? AND event_id=?', [input.goalId, input.eventId]);
      if (prior) { if (prior.input_json !== signature) throw new Error('event_conflict'); return { jobId: prior.job_id, duplicate: true }; }
      const t = now();
      // Coalescing is opt-in and only combines identical job configuration while pending.
      const group = input.coalesceKey === undefined ? undefined : db.get<JobRow>("SELECT j.* FROM scheduler_jobs j WHERE j.goal_id=? AND j.coalesce_key=? AND j.status='pending' AND j.kind=? AND j.payload_json=? AND j.semantics=? AND j.max_attempts=? AND (SELECT count(*) FROM scheduler_events e WHERE e.goal_id=j.goal_id AND e.job_id=j.id)<100 ORDER BY j.created_at,j.id LIMIT 1", [input.goalId, input.coalesceKey, input.kind, payload, input.semantics, attempts]);
      const id = group?.id ?? randomUUID();
      if (group) db.run('UPDATE scheduler_jobs SET due_at=max(due_at,?), updated_at=? WHERE id=?', [input.dueAt, t, id]);
      else db.run("INSERT INTO scheduler_jobs(id,goal_id,kind,payload_json,semantics,status,due_at,scheduled_for,max_attempts,coalesce_key,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?)", [id, input.goalId, input.kind, payload, input.semantics, input.dueAt, input.dueAt, attempts, input.coalesceKey ?? null, t, t]);
      db.run('INSERT INTO scheduler_events(goal_id,event_id,input_json,job_id) VALUES(?,?,?,?)', [input.goalId, input.eventId, signature, id]);
      return { jobId: id, duplicate: false };
    });
  }
  function backoff(attempt: number) { return Math.min(maxBackoff, base * 2 ** Math.min(attempt - 1, 30)); }
  function fencePlannerAttempts(jobId: string, leaseToken: string | null) {
    if (!leaseToken) return;
    db.run("INSERT INTO workflow_planner_diagnostics(attempt_id,code) SELECT a.id,'planner_attempt_fenced' FROM workflow_planner_attempts a JOIN workflow_planner_attempt_leases l ON l.attempt_id=a.id WHERE a.status='running' AND l.job_id=? AND l.lease_token=?", [jobId, leaseToken]);
    db.run("UPDATE workflow_planner_attempts SET status='failed' WHERE status='running' AND id IN (SELECT attempt_id FROM workflow_planner_attempt_leases WHERE job_id=? AND lease_token=?)", [jobId, leaseToken]);
  }
  function recover(t: number) {
    // Only touch a bounded number on each tick. An unknown external write is never replayed.
    const rows = db.all<JobRow>("SELECT * FROM scheduler_jobs WHERE status='running' AND lease_until<=? ORDER BY lease_until,id LIMIT ?", [t, maxPerTick]);
    for (const row of rows) {
      fencePlannerAttempts(row.id, row.lease_token);
      const status = row.semantics === 'external_unknown' ? 'held' : row.attempts >= row.max_attempts ? 'failed' : 'pending';
      db.run("UPDATE scheduler_jobs SET status=?,due_at=?,lease_token=NULL,lease_until=NULL,reason='lease_expired',updated_at=? WHERE id=? AND status='running' AND lease_until<=?", [status, t + backoff(row.attempts), t, row.id, t]);
      db.run("UPDATE scheduler_runs SET outcome='lease_expired',finished_at=? WHERE job_id=? AND attempt=? AND outcome='running'", [t, row.id, row.attempts]);
    }
    return rows.length;
  }
  function materialize(t: number) {
    const rows = db.all<ScheduleRow & { time_zone: string | null; minute_of_day: number | null; recurrence: 'daily' | 'weekly' | null; weekday: number | null }>('SELECT s.*,c.time_zone,c.minute_of_day,c.recurrence,c.weekday FROM scheduler_schedules s LEFT JOIN scheduler_civil_schedules c ON c.goal_id=s.goal_id AND c.schedule_id=s.schedule_id WHERE s.active=1 AND s.next_due<=? ORDER BY s.next_due,s.goal_id,s.schedule_id LIMIT ?', [t, maxPerTick]);
    for (const s of rows) {
      // One latest occurrence, skipping older missed intervals; preserve the original cadence.
      const pattern = s.time_zone !== null && s.minute_of_day !== null && s.recurrence !== null && s.weekday !== null ? { timeZone: s.time_zone, minuteOfDay: s.minute_of_day, recurrence: s.recurrence, weekday: s.weekday } : undefined;
      const due = pattern ? Math.max(s.next_due, latestCivilOccurrence(t, pattern)) : s.next_due + Math.floor((t - s.next_due) / s.interval_ms) * s.interval_ms;
      const nextDue = pattern ? nextCivilOccurrence(due, pattern) : due + s.interval_ms;
      db.run("INSERT OR IGNORE INTO scheduler_jobs(id,goal_id,kind,payload_json,semantics,status,due_at,scheduled_for,max_attempts,schedule_id,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?)", [randomUUID(), s.goal_id, s.kind, s.payload_json, s.semantics, due, due, s.max_attempts, s.schedule_id, t, t]);
      db.run('UPDATE scheduler_schedules SET next_due=? WHERE goal_id=? AND schedule_id=? AND next_due=?', [nextDue, s.goal_id, s.schedule_id, s.next_due]);
    }
    return rows.length;
  }
  function reserve(t: number): HandlerContext | undefined {
    const dayStart = Math.floor(t / DAY) * DAY;
    const row = db.get<JobRow>(`SELECT j.* FROM scheduler_jobs j WHERE j.status='pending' AND j.due_at<=? AND NOT EXISTS (SELECT 1 FROM scheduler_jobs active WHERE active.goal_id=j.goal_id AND active.status='running') AND (SELECT count(*) FROM scheduler_runs r WHERE r.goal_id=j.goal_id AND r.started_at>=? AND r.started_at<?)<? ORDER BY j.due_at,j.created_at,j.id LIMIT 1`, [t, dayStart, dayStart + DAY, dailyLimit]);
    if (!row) return undefined;
    const token = randomUUID(), runId = randomUUID(), until = t + leaseMs, attempt = row.attempts + 1;
    db.run("UPDATE scheduler_jobs SET status='running',attempts=?,lease_token=?,lease_until=?,updated_at=? WHERE id=? AND status='pending'", [attempt, token, until, t, row.id]);
    db.run("INSERT INTO scheduler_runs(id,job_id,goal_id,attempt,started_at,outcome) VALUES(?,?,?,?,?,'running')", [runId, row.id, row.goal_id, attempt, t]);
    const eventIds = db.all<{ event_id: string }>('SELECT event_id FROM scheduler_events WHERE goal_id=? AND job_id=? ORDER BY event_id', [row.goal_id, row.id]).map(x => x.event_id);
    return { jobId: row.id, runId, effectId: row.id, leaseToken: token, leaseUntil: until, goalId: row.goal_id, kind: row.kind, payload: JSON.parse(row.payload_json), eventIds, attempt, scheduledFor: row.scheduled_for };
  }
  async function tick(handler: Handler) {
    const start = now();
    const housekeeping = db.tx(() => ({ recovered: recover(start), materialized: materialize(start) }));
    let started = 0;
    for (; started < maxPerTick; started++) {
      const ctx = db.tx(() => reserve(now()));
      if (!ctx) break;
      let result: 'progress' | 'no_progress' | 'error';
      try { const response = await handler(ctx); if (response?.outcome !== 'progress' && response?.outcome !== 'no_progress') throw new Error('invalid_handler_result'); result = response.outcome; }
      catch { result = 'error'; }
      db.tx(() => {
        const t = now();
        const row = db.get<JobRow>("SELECT * FROM scheduler_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?", [ctx.jobId, ctx.leaseToken, t]);
        if (!row) return; // Lease expired/cancelled: a stale handler may not commit scheduler state.
        fencePlannerAttempts(row.id, row.lease_token);
        const status = result === 'progress' ? 'succeeded' : row.semantics === 'external_unknown' ? 'held' : result === 'no_progress' ? 'stopped' : row.attempts >= row.max_attempts ? 'failed' : 'pending';
        db.run('UPDATE scheduler_jobs SET status=?,due_at=?,lease_token=NULL,lease_until=NULL,reason=?,updated_at=? WHERE id=?', [status, result === 'error' ? t + backoff(row.attempts) : row.due_at, result, t, row.id]);
        db.run('UPDATE scheduler_runs SET outcome=?,finished_at=? WHERE id=?', [result, t, ctx.runId]);
      });
    }
    return { ...housekeeping, started };
  }
  /** Save an evidence-bearing review; proposals require human review and grant no permission to apply them. */
  function saveReview(ctx: HandlerContext, artifact: ReviewArtifact) {
    validateReviewArtifact(artifact);
    return db.tx(() => {
      const t = now();
      const row = db.get<JobRow>("SELECT * FROM scheduler_jobs WHERE id=? AND goal_id=? AND status='running' AND lease_token=? AND lease_until>?", [ctx.jobId, ctx.goalId, ctx.leaseToken, t]);
      if (!row || !['daily_review', 'weekly_review'].includes(row.kind) || row.semantics !== 'local_idempotent') throw new Error('review_lease_invalid');
      const value = json(artifact);
      const old = db.get<{ artifact_json: string }>('SELECT artifact_json FROM scheduler_reviews WHERE job_id=?', [row.id]);
      if (old && old.artifact_json !== value) throw new Error('review_conflict');
      const approvalStatus = artifact.proposals.length ? 'human_review_required' : 'no_action';
      if (!old) db.run('INSERT INTO scheduler_reviews(job_id,goal_id,kind,artifact_json,approval_status,created_at) VALUES(?,?,?,?,?,?)', [row.id, row.goal_id, row.kind, value, approvalStatus, t]);
      return { jobId: row.id, approvalStatus };
    });
  }
  function cancelJob(goalId: string, jobId: string) {
    return db.tx(() => {
      const row = db.get<JobRow>('SELECT * FROM scheduler_jobs WHERE goal_id=? AND id=?', [goalId, jobId]);
      if (!row) throw new Error('job_not_found');
      if (!['pending', 'running'].includes(row.status)) return false;
      const t = now(), status = row.status === 'running' && row.semantics === 'external_unknown' ? 'held' : 'cancelled';
      if (row.status === 'running') fencePlannerAttempts(row.id, row.lease_token);
      db.run("UPDATE scheduler_jobs SET status=?,reason='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?", [status, t, jobId]);
      if (row.status === 'running') db.run("UPDATE scheduler_runs SET outcome='cancelled',finished_at=? WHERE job_id=? AND attempt=? AND outcome='running'", [t, jobId, row.attempts]);
      return true;
    });
  }
  function cancelSchedule(goalId: string, scheduleId: string) {
    return db.tx(() => {
      const changed = db.run('UPDATE scheduler_schedules SET active=0 WHERE goal_id=? AND schedule_id=? AND active=1', [goalId, scheduleId]);
      if (!changed.changes) return false;
      // A cancelled recurrence must not start an already-materialized occurrence.
      // Preserve its row for audit and fence any in-flight handler through cancelJob.
      const running = db.all<{ id: string }>("SELECT id FROM scheduler_jobs WHERE goal_id=? AND schedule_id=? AND status='running'", [goalId, scheduleId]);
      for (const job of running) cancelJob(goalId, job.id);
      const cancelledAt = now();
      // A previous uncertain send remains held, but a later confirmed absence
      // must not reactivate it after its recurrence was cancelled.
      db.run("INSERT OR IGNORE INTO scheduler_cancelled_holds(job_id,cancelled_at) SELECT id,? FROM scheduler_jobs WHERE goal_id=? AND schedule_id=? AND status='held'", [cancelledAt, goalId, scheduleId]);
      db.run("UPDATE scheduler_jobs SET status='cancelled',reason='cancelled',updated_at=? WHERE goal_id=? AND schedule_id=? AND status='pending'", [cancelledAt, goalId, scheduleId]);
      return true;
    });
  }
  /** A human/host must verify the external outcome before calling this; note is an audit record. */
  function reconcile(goalId: string, jobId: string, resolution: 'confirmed_sent' | 'confirmed_not_sent' | 'abandoned', note: string) {
    if (!validText(note) || !['confirmed_sent', 'confirmed_not_sent', 'abandoned'].includes(resolution)) throw new Error('invalid_reconciliation');
    return db.tx(() => {
      const row = db.get<JobRow>("SELECT * FROM scheduler_jobs WHERE goal_id=? AND id=? AND status='held'", [goalId, jobId]);
      if (!row) throw new Error('held_job_not_found');
      const t = now();
      const cancelledHold = db.get('SELECT job_id FROM scheduler_cancelled_holds WHERE job_id=?', [jobId]);
      const status = resolution === 'confirmed_sent' ? 'succeeded' : resolution === 'abandoned' || row.reason === 'cancelled' || cancelledHold ? 'cancelled' : row.attempts >= row.max_attempts ? 'failed' : 'pending';
      db.run('UPDATE scheduler_jobs SET status=?,due_at=?,reason=?,updated_at=? WHERE id=?', [status, t, resolution, t, jobId]);
      db.run('INSERT INTO scheduler_reconciliations(job_id,resolution,note,created_at) VALUES(?,?,?,?)', [jobId, resolution, note, t]);
      return status;
    });
  }
  function inspect(goalId: string) {
    return {
      schedules: db.all('SELECT s.*,c.time_zone,c.minute_of_day,c.recurrence,c.weekday FROM scheduler_schedules s LEFT JOIN scheduler_civil_schedules c ON c.goal_id=s.goal_id AND c.schedule_id=s.schedule_id WHERE s.goal_id=? ORDER BY s.schedule_id', [goalId]),
      jobs: db.all('SELECT * FROM scheduler_jobs WHERE goal_id=? ORDER BY created_at,id', [goalId]),
      events: db.all('SELECT * FROM scheduler_events WHERE goal_id=? ORDER BY event_id', [goalId]),
      runs: db.all('SELECT * FROM scheduler_runs WHERE goal_id=? ORDER BY started_at,id', [goalId]),
      reviews: db.all('SELECT * FROM scheduler_reviews WHERE goal_id=? ORDER BY created_at,job_id', [goalId]),
      reconciliations: db.all('SELECT r.* FROM scheduler_reconciliations r JOIN scheduler_jobs j ON j.id=r.job_id WHERE j.goal_id=? ORDER BY r.id', [goalId])
    };
  }
  return { schedule, enqueue, tick, inspect, saveReview, cancelJob, cancelSchedule, reconcile };
}
