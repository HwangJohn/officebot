import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.js';
import { createDurableScheduler } from '../src/durableScheduler.js';
import { buildSystemOverview } from '../src/systemOverview.js';
const now = new Date('2026-10-27T06:00:00.000Z');
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'overview-test-'));
  const db = new Db(join(dir, 'fresh.sqlite'));
  createDurableScheduler(db, { now: () => now.getTime() });
  for (const id of ['a', 'b']) {
    db.run('INSERT INTO workflow_goals(id,title,owner,completion,current_plan,created_at) VALUES(?,?,?,?,?,?)', [id, `목표 ${id}`, 'local', 'done', 1, now.toISOString()]);
    db.run('INSERT INTO workspace_goals(goal_id,owner) VALUES(?,?)', [id, 'local']);
    db.run('INSERT INTO workflow_goal_projects(goal_id,project) VALUES(?,?)', [id, `project-${id}`]);
    db.run('INSERT INTO workflow_plans(goal_id,version,created_at) VALUES(?,?,?)', [id, 1, now.toISOString()]);
    db.run('INSERT INTO workflow_steps(goal_id,plan_version,position,step_id,tool,input_json,depends_json,status) VALUES(?,?,?,?,?,?,?,?)', [id, 1, 0, 's', 'record_fact', '{}', '[]', id === 'a' ? 'complete' : 'pending']);
  }
  db.run("INSERT INTO workflow_facts(goal_id,fact_key,value,source,observed_at,plan_version,step_id) VALUES('a','x','PRIVATE FACT','local',?,1,'s')", [now.toISOString()]);
  db.run("INSERT INTO workflow_artifacts(goal_id,kind,content,source_fact_id,plan_version,step_id,created_at) VALUES('a','draft','PRIVATE ARTIFACT',1,1,'s',?)", [now.toISOString()]);
  db.run("INSERT INTO events(id,source,source_event_id,occurred_at,project,title,body) VALUES(1,'outlook','e',?,'project-a','회의 자료','PRIVATE BODY')", [now.toISOString()]);
  db.run("INSERT INTO mock_connector_events(source,account,project,external_id,revision,occurred_at,operation,details_json,content_hash,event_id,received_at) VALUES('outlook','PRIVATE ACCOUNT','project-a','thread',1,?,'upsert','{}','hash',1,?)", [now.toISOString(), now.toISOString()]);
  for (const [id, expiry, version] of [['pending','2026-10-28T06:00:00Z',1], ['expired','2026-10-26T06:00:00Z',1], ['changed','2026-10-28T06:00:00Z',2]] as const) {
    db.run("INSERT INTO workspace_approvals(id,goal_id,plan_version,artifact_id,target_event_id,target_revision,action_type,payload_json,scope_hash,status,expires_at,created_at) VALUES(?,'a',?,1,1,1,'mock_reply','PRIVATE PAYLOAD',?,'pending',?,?)", [id, version, id, expiry, now.toISOString()]);
  }
  db.run("INSERT INTO goals(id,task_version) VALUES('proposal',3)");
  db.run("INSERT INTO approvals(id,task_version,status,expires_at,created_at) VALUES('legacy',3,'pending','2026-10-28T06:00:00Z',?)", [now.toISOString()]);
  db.run("INSERT INTO discord_notification_outbox(id,goal_id,approval_id,owner_id,guild_id,channel_id,content,status,created_at,updated_at) VALUES('outbox','a','pending','owner-secret','guild-secret','channel-secret','SECRET','held',?,?)", [now.getTime(),now.getTime()]);
  for (const [id, goal, status, due] of [['running','a','running',-1],['queued','b','pending',-1],['waiting','a','pending',10000],['failed','b','failed',-1],['held','a','held',-1]] as const) {
    db.run("INSERT INTO scheduler_jobs(id,goal_id,kind,payload_json,semantics,status,due_at,scheduled_for,max_attempts,created_at,updated_at) VALUES(?,?,'notification','SECRET',?,?,?, ?,2,?,?)", [id,goal,id === 'held' ? 'external_unknown' : 'local_idempotent',status,now.getTime()+due,now.getTime()+due,now.getTime(),now.getTime()]);
  }
  db.run("INSERT INTO scheduler_schedules(goal_id,schedule_id,kind,payload_json,semantics,max_attempts,next_due,interval_ms,active) VALUES('b','daily','daily_review','SECRET','local_idempotent',1,?,86400000,1)", [now.getTime()+60000]);
  return { db, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('cross-goal counts, known invalid approvals and held delivery are read-only', () => {
  const f = fixture();
  try {
    const before = f.db.get<{ n: number }>('SELECT total_changes() n')!.n;
    const o = buildSystemOverview(f.db, { now, engine: 'offline' });
    assert.deepEqual([o.goals.active, o.goals.completed], [1,1]);
    assert.deepEqual([o.approvals.pending, o.approvals.invalid], [1,2]);
    assert.deepEqual([o.legacyApprovals.pending,o.legacyApprovals.invalid], [1,0]);
    assert.deepEqual([o.jobs.running,o.jobs.queued,o.jobs.waiting,o.jobs.failed,o.jobs.held], [1,1,1,1,1]);
    assert.equal(o.jobs.attention.find(x => x.status === 'held')?.goalId, 'a');
    assert.equal(o.schedules[0].goalId, 'b');
    assert.equal(o.scheduleCount, 1);
    assert.equal(o.deliveries.held, 1);
    assert.equal(o.deliveries.attention[0].goalId, 'a');
    assert.equal(o.events[0].title, '회의 자료');
    assert.equal(o.artifacts[0].goalId, 'a');
    assert.equal(f.db.get<{ n: number }>('SELECT total_changes() n')!.n, before);
    assert.doesNotMatch(JSON.stringify(o), /PRIVATE|SECRET/);
    f.db.run("UPDATE scheduler_jobs SET status='held' WHERE id='queued'");
    const next = buildSystemOverview(f.db, { now });
    assert.deepEqual([next.jobs.queued,next.jobs.held], [0,2]);
    f.db.run("INSERT INTO kv(key,value) VALUES('clock','2026-10-25T06:00:00Z')");
    const simulated = buildSystemOverview(f.db, { now });
    assert.deepEqual([simulated.approvals.pending, simulated.approvals.invalid], [2,1]);
    assert.equal(simulated.approvals.clock, '2026-10-25T06:00:00Z');
  } finally { f.close(); }
});
test('configuration and authenticated recent observation remain separate', () => {
  const f = fixture();
  try {
    const options = { now, engine: 'openai' as const, backgroundScheduler: true, discordConfigured: true };
    const unobserved = buildSystemOverview(f.db, options).runtime;
    assert.equal(unobserved.model, 'unobserved');
    assert.equal(unobserved.discord.state, 'unobserved');
    assert.equal(unobserved.temporal, 'disabled');
    assert.equal(unobserved.scheduler, 'configured');
    const fresh = buildSystemOverview(f.db, { ...options, discordObservation: { authenticated: true, state: 'connected', observedAt: '2026-10-27T05:59:00Z' } }).runtime;
    assert.equal(fresh.discord.state, 'connected');
    const stale = buildSystemOverview(f.db, { ...options, discordObservation: { authenticated: true, state: 'connected', observedAt: '2026-10-27T05:00:00Z' } }).runtime;
    assert.equal(stale.discord.state, 'unobserved');
    assert.equal(stale.discord.observedAt, null);
  } finally { f.close(); }
});

test('deferred approvals remain visible on their goal and become invalid on expiry or changed target', () => {
  const f = fixture();
  try {
    f.db.run("UPDATE workspace_approvals SET status='deferred' WHERE id IN ('pending','expired')");
    let overview = buildSystemOverview(f.db, { now });
    assert.deepEqual([overview.approvals.pending, overview.approvals.deferred, overview.approvals.invalid], [0, 1, 2]);
    assert.equal(overview.approvals.items.find(a => a.id === 'pending')?.status, 'deferred');
    assert.equal(overview.approvals.items.find(a => a.id === 'pending')?.goalId, 'a');
    assert.equal(overview.approvals.items.find(a => a.id === 'expired')?.status, 'invalid');
    f.db.run("INSERT INTO events(id,source,source_event_id,occurred_at,project,title) VALUES(2,'outlook','e2',?,'project-a','changed')", [now.toISOString()]);
    f.db.run("INSERT INTO mock_connector_events(source,account,project,external_id,revision,occurred_at,operation,details_json,content_hash,event_id,received_at) VALUES('outlook','PRIVATE ACCOUNT','project-a','thread',2,?,'upsert','{}','hash2',2,?)", [now.toISOString(), now.toISOString()]);
    overview = buildSystemOverview(f.db, { now });
    assert.equal(overview.approvals.deferred, 0);
    assert.equal(overview.approvals.items.find(a => a.id === 'pending')?.status, 'invalid');
    assert.equal(f.db.get<any>("SELECT status FROM workspace_approvals WHERE id='pending'").status, 'deferred');
  } finally { f.close(); }
});
