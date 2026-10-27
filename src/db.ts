import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export class Db {
  db: DatabaseSync;
  private transactionDepth = 0;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.migrate();
  }
  migrate() {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, source TEXT, source_event_id TEXT UNIQUE, occurred_at TEXT, project TEXT, kind TEXT, title TEXT, body TEXT, raw_json TEXT, processed_at TEXT);
CREATE TABLE IF NOT EXISTS duplicate_attempts(id INTEGER PRIMARY KEY, source_event_id TEXT, attempted_at TEXT);
CREATE TABLE IF NOT EXISTS mock_connector_events(id INTEGER PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, project TEXT NOT NULL, external_id TEXT NOT NULL, revision INTEGER NOT NULL, occurred_at TEXT NOT NULL, operation TEXT NOT NULL, details_json TEXT NOT NULL, content_hash TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES events(id), received_at TEXT NOT NULL, UNIQUE(source,account,project,external_id,revision));
CREATE TABLE IF NOT EXISTS evidence(id INTEGER PRIMARY KEY, event_id INTEGER, source TEXT, title TEXT, excerpt TEXT, trusted INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY, project TEXT, due_date TEXT, quote TEXT, status TEXT, next_step TEXT, wait_condition TEXT, next_check_at TEXT, task_version INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS todos(id TEXT PRIMARY KEY, title TEXT, due_date TEXT, status TEXT, scope TEXT, task_version INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS artifacts(id INTEGER PRIMARY KEY, goal_id TEXT, kind TEXT, version INTEGER, content TEXT, evidence_json TEXT, created_at TEXT, UNIQUE(goal_id, kind, version));
CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, action_type TEXT, target TEXT, payload_json TEXT, payload_hash TEXT, task_version INTEGER, target_version INTEGER, status TEXT, expires_at TEXT, created_at TEXT, decided_at TEXT, decision_note TEXT, reissue INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS outcomes(id INTEGER PRIMARY KEY, action_id TEXT UNIQUE, action_type TEXT, status TEXT, result_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS mock_effect_reconciliations(approval_id TEXT PRIMARY KEY REFERENCES approvals(id), resolution TEXT NOT NULL, payload_hash TEXT NOT NULL, evidence_json TEXT NOT NULL, reviewer TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mock_processing_recoveries(approval_id TEXT PRIMARY KEY REFERENCES approvals(id), payload_hash TEXT NOT NULL, review_token TEXT NOT NULL, reviewer TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sdk_snapshots(id INTEGER PRIMARY KEY, approval_id TEXT UNIQUE, engine TEXT, snapshot TEXT, meta_json TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS analysis_records(id INTEGER PRIMARY KEY, normalized_goal TEXT, engine TEXT, context_hash TEXT, input_fingerprint TEXT, task_version INTEGER, context_json TEXT, output_json TEXT, meta_json TEXT, status TEXT, created_at TEXT, UNIQUE(normalized_goal, engine, context_hash));
CREATE TABLE IF NOT EXISTS digests(id INTEGER PRIMARY KEY, kind TEXT, content TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, role TEXT, content TEXT, analysis_id INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS memory_message_corrections(message_id INTEGER NOT NULL REFERENCES messages(id), version INTEGER NOT NULL, content TEXT, created_at TEXT NOT NULL, PRIMARY KEY(message_id,version));
CREATE TABLE IF NOT EXISTS memory_preferences(project TEXT NOT NULL, owner TEXT NOT NULL, pref_key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT, created_at TEXT NOT NULL, PRIMARY KEY(project,owner,pref_key,version));
CREATE TABLE IF NOT EXISTS memory_scoped_messages(source_id TEXT NOT NULL, project TEXT NOT NULL, owner TEXT NOT NULL, version INTEGER NOT NULL, content TEXT, created_at TEXT NOT NULL, PRIMARY KEY(source_id,version));
CREATE TABLE IF NOT EXISTS discord_commands(message_id TEXT PRIMARY KEY, action TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discord_notification_settings(goal_id TEXT PRIMARY KEY REFERENCES workspace_goals(goal_id), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS discord_notification_quiet_hours(goal_id TEXT PRIMARY KEY REFERENCES workspace_goals(goal_id), time_zone TEXT NOT NULL, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS discord_notification_outbox(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workspace_goals(goal_id), approval_id TEXT NOT NULL UNIQUE REFERENCES workspace_approvals(id), owner_id TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','held','cancelled')), claim_token TEXT, lease_until INTEGER, discord_message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS discord_notification_deferrals(notification_id TEXT PRIMARY KEY REFERENCES discord_notification_outbox(id), until_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS discord_notification_queue ON discord_notification_outbox(status,created_at,id);
CREATE INDEX IF NOT EXISTS discord_notification_leases ON discord_notification_outbox(status,lease_until);
CREATE TABLE IF NOT EXISTS discord_notification_reconciliation(notification_id TEXT PRIMARY KEY REFERENCES discord_notification_outbox(id), message_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, command_message_id TEXT NOT NULL, verified_at INTEGER NOT NULL, message_timestamp TEXT NOT NULL, content_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discord_notification_batches(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workspace_goals(goal_id), content TEXT NOT NULL, status TEXT NOT NULL, claim_token TEXT, lease_until INTEGER, message_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS discord_notification_batch_members(notification_id TEXT PRIMARY KEY REFERENCES discord_notification_outbox(id), batch_id TEXT NOT NULL REFERENCES discord_notification_batches(id), position INTEGER NOT NULL, UNIQUE(batch_id,position));
CREATE TABLE IF NOT EXISTS discord_notification_batch_reconciliation(batch_id TEXT PRIMARY KEY REFERENCES discord_notification_batches(id), message_id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, command_message_id TEXT NOT NULL, verified_at INTEGER NOT NULL, message_timestamp TEXT NOT NULL, content_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS workflow_goals(id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL, completion TEXT NOT NULL, current_plan INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_goals(goal_id TEXT PRIMARY KEY REFERENCES workflow_goals(id), owner TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_activity(effect_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workspace_goals(goal_id), kind TEXT NOT NULL, event_id INTEGER NOT NULL REFERENCES events(id), details_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_event_plans(effect_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workspace_goals(goal_id), event_id INTEGER NOT NULL REFERENCES events(id), plan_version INTEGER NOT NULL, FOREIGN KEY(goal_id,plan_version) REFERENCES workflow_plans(goal_id,version));
CREATE TABLE IF NOT EXISTS workspace_empty_reviews(job_id TEXT PRIMARY KEY REFERENCES scheduler_jobs(id), goal_id TEXT NOT NULL REFERENCES workspace_goals(goal_id), kind TEXT NOT NULL, artifact_json TEXT NOT NULL, approval_status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_improvements(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workspace_goals(goal_id), title TEXT NOT NULL, rationale TEXT NOT NULL, patch TEXT NOT NULL, evidence_json TEXT NOT NULL, source_hash TEXT NOT NULL, status TEXT NOT NULL, review_json TEXT, created_at TEXT NOT NULL, reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS workspace_approvals(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workspace_goals(goal_id), plan_version INTEGER NOT NULL, artifact_id INTEGER NOT NULL REFERENCES workflow_artifacts(id), target_event_id INTEGER NOT NULL REFERENCES events(id), target_revision INTEGER NOT NULL, action_type TEXT NOT NULL, payload_json TEXT NOT NULL, scope_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, reviewer TEXT, decided_at TEXT);
CREATE TABLE IF NOT EXISTS workspace_effects(id INTEGER PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE REFERENCES workspace_approvals(id), action_type TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_approval_audit(id INTEGER PRIMARY KEY, approval_id TEXT NOT NULL REFERENCES workspace_approvals(id), actor TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_plans(goal_id TEXT NOT NULL REFERENCES workflow_goals(id), version INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(goal_id,version));
CREATE TABLE IF NOT EXISTS workflow_planner_policies(goal_id TEXT NOT NULL REFERENCES workflow_goals(id), version INTEGER NOT NULL, policy_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(goal_id,version));
CREATE TABLE IF NOT EXISTS workflow_plan_authorities(goal_id TEXT NOT NULL, plan_version INTEGER NOT NULL, policy_version INTEGER NOT NULL, PRIMARY KEY(goal_id,plan_version), FOREIGN KEY(goal_id,plan_version) REFERENCES workflow_plans(goal_id,version), FOREIGN KEY(goal_id,policy_version) REFERENCES workflow_planner_policies(goal_id,version));
CREATE TABLE IF NOT EXISTS workflow_plan_memory(goal_id TEXT NOT NULL, plan_version INTEGER NOT NULL, memory_json TEXT NOT NULL, PRIMARY KEY(goal_id,plan_version), FOREIGN KEY(goal_id,plan_version) REFERENCES workflow_plans(goal_id,version));
CREATE TABLE IF NOT EXISTS workflow_goal_projects(goal_id TEXT PRIMARY KEY REFERENCES workflow_goals(id), project TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_policy_evidence(goal_id TEXT NOT NULL, policy_version INTEGER NOT NULL, evidence_id INTEGER NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(goal_id,policy_version,evidence_id), FOREIGN KEY(goal_id,policy_version) REFERENCES workflow_planner_policies(goal_id,version));
CREATE TABLE IF NOT EXISTS workflow_planner_attempts(id INTEGER PRIMARY KEY, goal_id TEXT NOT NULL, policy_version INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(goal_id,policy_version) REFERENCES workflow_planner_policies(goal_id,version));
CREATE TABLE IF NOT EXISTS workflow_planner_diagnostics(attempt_id INTEGER PRIMARY KEY REFERENCES workflow_planner_attempts(id), code TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_planner_attempt_leases(attempt_id INTEGER PRIMARY KEY REFERENCES workflow_planner_attempts(id), job_id TEXT NOT NULL, run_id TEXT NOT NULL, lease_token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_manual_attempt_deadlines(attempt_id INTEGER PRIMARY KEY REFERENCES workflow_planner_attempts(id), deadline_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS workflow_manual_attempt_deadline ON workflow_manual_attempt_deadlines(deadline_ms);
CREATE TABLE IF NOT EXISTS workflow_steps(goal_id TEXT NOT NULL, plan_version INTEGER NOT NULL, position INTEGER NOT NULL, step_id TEXT NOT NULL, tool TEXT NOT NULL, input_json TEXT NOT NULL, depends_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, PRIMARY KEY(goal_id,plan_version,step_id), UNIQUE(goal_id,plan_version,position), FOREIGN KEY(goal_id,plan_version) REFERENCES workflow_plans(goal_id,version));
CREATE TABLE IF NOT EXISTS workflow_facts(id INTEGER PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workflow_goals(id), fact_key TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL, observed_at TEXT NOT NULL, plan_version INTEGER NOT NULL, step_id TEXT NOT NULL, UNIQUE(goal_id,plan_version,step_id));
CREATE TABLE IF NOT EXISTS workflow_personal_tasks(id INTEGER PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workflow_goals(id), task_key TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, source_fact_id INTEGER NOT NULL REFERENCES workflow_facts(id), plan_version INTEGER NOT NULL, updated_at TEXT NOT NULL, UNIQUE(goal_id,task_key));
CREATE TABLE IF NOT EXISTS workflow_personal_task_completions(task_id INTEGER PRIMARY KEY REFERENCES workflow_personal_tasks(id), goal_id TEXT NOT NULL REFERENCES workflow_goals(id), plan_version INTEGER NOT NULL, actor TEXT NOT NULL, completed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_artifacts(id INTEGER PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES workflow_goals(id), kind TEXT NOT NULL, content TEXT NOT NULL, source_fact_id INTEGER NOT NULL REFERENCES workflow_facts(id), plan_version INTEGER NOT NULL, step_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(goal_id,plan_version,step_id));
`);
  }
  get<T = any>(sql: string, params: SQLInputValue[] = []): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  all<T = any>(sql: string, params: SQLInputValue[] = []): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  run(sql: string, params: SQLInputValue[] = []) { return this.db.prepare(sql).run(...params); }
  tx<T>(fn: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `nested_${depth}`;
    this.db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth++;
    try {
      const value = fn();
      this.db.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      if (depth === 0) this.db.exec('ROLLBACK');
      else this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally { this.transactionDepth--; }
  }
  close() { this.db.close(); }
}

export const j = {
  parse<T>(s: string | null | undefined, fallback: T): T { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } },
  str(v: unknown) { return JSON.stringify(v); }
};
