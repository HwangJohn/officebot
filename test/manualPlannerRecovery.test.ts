import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../src/core.js';

test('a killed manual planner is recovered after its deadline without refunding its budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-planner-recovery-')), dbPath = join(dir, 'test.sqlite');
  const entry = pathToFileURL(resolve(process.cwd(), 'src/core.ts')).href;
  const source = `
    import { createService } from ${JSON.stringify(entry)};
    const svc = createService({ dbPath: process.argv[1] });
    svc.workflow.createGoal({ id: 'manual', title: 'Synthetic', owner: 'local', completion: 'Review' });
    svc.workflow.configurePlanner('manual', 0, { allowedSources: [], trustedFacts: [], allowedArtifactKinds: ['draft'], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 1000, maxPlanVersions: 3, maxPlannerAttempts: 1 });
    setInterval(() => {}, 1000);
    void svc.workflow.planWithAdapter('manual', 0, async () => { process.stdout.write('READY\\n'); return new Promise(() => {}); }, 1200);
  `;
  const child = spawn(process.execPath, ['--experimental-sqlite', '--import', 'tsx', '--input-type=module', '-e', source, dbPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => no(new Error('child_ready_timeout')), 20_000);
      child.stdout.on('data', chunk => { if (String(chunk).includes('READY')) { clearTimeout(timer); yes(); } });
      child.once('exit', () => { clearTimeout(timer); no(new Error('child_exited_before_ready')); });
    });
    const exited = once(child, 'exit'); child.kill(); await exited;
    await delay(1350);
    const reopened = createService({ dbPath });
    try {
      assert.equal(reopened.db.get<any>("SELECT status FROM workflow_planner_attempts WHERE goal_id='manual'").status, 'failed');
      assert.equal(reopened.workflow.inspect('manual').plannerAttempts[0].code, 'planner_deadline_elapsed');
      assert.equal(reopened.db.get<any>("SELECT count(*) n FROM workflow_planner_attempts WHERE goal_id='manual'").n, 1);
      await assert.rejects(reopened.workflow.planWithAdapter('manual', 0, async () => ({})), /planner_attempt_budget_exceeded/);
    } finally { reopened.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening another service does not fence a live manual attempt before its deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-planner-live-')), dbPath = join(dir, 'test.sqlite');
  const first = createService({ dbPath });
  let second: ReturnType<typeof createService> | undefined;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let pending: Promise<unknown> | undefined;
  try {
    const fact = { key: 'source', value: 'Synthetic', source: 'mock:source', observedAt: '2026-10-27T00:00:00Z' };
    first.workflow.createGoal({ id: 'live', title: 'Synthetic', owner: 'local', completion: 'Review' });
    first.workflow.configurePlanner('live', 0, { allowedSources: [fact.source], trustedFacts: [fact], allowedArtifactKinds: ['draft'], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 1000, maxPlanVersions: 3, maxPlannerAttempts: 2 });
    pending = first.workflow.planWithAdapter('live', 0, async () => { entered(); await gate; return { steps: [{ id: 'fact', tool: 'record_fact', input: fact, dependsOn: [] }, { id: 'draft', tool: 'create_artifact', input: { kind: 'draft', content: 'Local draft', factStepId: 'fact' }, dependsOn: ['fact'] }] }; }, 5000);
    await ready;
    second = createService({ dbPath });
    assert.equal(second.db.get<any>("SELECT status FROM workflow_planner_attempts WHERE goal_id='live'").status, 'running');
    release(); assert.equal(await pending, 1);
    assert.equal(second.db.get<any>("SELECT status FROM workflow_planner_attempts WHERE goal_id='live'").status, 'succeeded');
  } finally { release(); await pending?.catch(() => {}); second?.close(); first.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('periodic recovery handles newly expired attempts while preserving legacy and later attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-planner-periodic-')), dbPath = join(dir, 'test.sqlite');
  const service = createService({ dbPath });
  try {
    service.workflow.createGoal({ id: 'goal', title: 'Synthetic', owner: 'local', completion: 'Review' });
    service.workflow.configurePlanner('goal', 0, { allowedSources: [], trustedFacts: [], allowedArtifactKinds: ['draft'], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 1000, maxPlanVersions: 3, maxPlannerAttempts: 2000 });
    const addAttempt = (status: string, deadline?: number) => {
      const id = Number(service.db.run('INSERT INTO workflow_planner_attempts(goal_id,policy_version,status,created_at) VALUES(?,1,?,?)', ['goal', status, '2026-10-27T00:00:00Z']).lastInsertRowid);
      if (deadline !== undefined) service.db.run('INSERT INTO workflow_manual_attempt_deadlines(attempt_id,deadline_ms) VALUES(?,?)', [id, deadline]);
      return id;
    };
    // A large set of completed old deadlines must not starve live expired rows.
    service.db.tx(() => { for (let i = 0; i < 1000; i++) addAttempt('succeeded', Date.now() - 1000); });
    const expired = addAttempt('running', Date.now() + 100);
    const live = addAttempt('running', Date.now() + 30_000);
    const legacy = addAttempt('running');
    await delay(2300);
    assert.equal(service.db.get<any>('SELECT status FROM workflow_planner_attempts WHERE id=?', [expired]).status, 'failed');
    assert.equal(service.db.get<any>('SELECT code FROM workflow_planner_diagnostics WHERE attempt_id=?', [expired]).code, 'planner_deadline_elapsed');
    assert.equal(service.db.get<any>('SELECT status FROM workflow_planner_attempts WHERE id=?', [live]).status, 'running');
    assert.equal(service.db.get<any>('SELECT status FROM workflow_planner_attempts WHERE id=?', [legacy]).status, 'running');
    assert.equal(service.db.get('SELECT code FROM workflow_planner_diagnostics WHERE attempt_id=?', [legacy]), undefined);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a result arriving after its deadline cannot commit even if the timer is delayed', async () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    const fact = { key: 'source', value: 'Synthetic', source: 'mock:source', observedAt: '2026-10-27T00:00:00Z' };
    service.workflow.createGoal({ id: 'late', title: 'Synthetic', owner: 'local', completion: 'Review' });
    service.workflow.configurePlanner('late', 0, { allowedSources: [fact.source], trustedFacts: [fact], allowedArtifactKinds: ['draft'], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 1000, maxPlanVersions: 3, maxPlannerAttempts: 2 });
    await assert.rejects(service.workflow.planWithAdapter('late', 0, async () => {
      const until = Date.now() + 50; while (Date.now() < until) { /* delay timer callbacks */ }
      return { steps: [{ id: 'fact', tool: 'record_fact', input: fact, dependsOn: [] }, { id: 'draft', tool: 'create_artifact', input: { kind: 'draft', content: 'Local draft', factStepId: 'fact' }, dependsOn: ['fact'] }] };
    }, 10), /planner_timeout/);
    assert.equal(service.db.get<any>("SELECT status FROM workflow_planner_attempts WHERE goal_id='late'").status, 'failed');
    assert.equal(service.workflow.inspect('late').plans.length, 0);
  } finally { service.close(); }
});
