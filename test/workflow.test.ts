import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/core.js';
import { fixtures } from '../src/fixtures.js';
import type { PlannerPolicy, WorkflowStep } from '../src/workflow.js';

const plan = (source: string, value: string): WorkflowStep[] => [
  { id: 'fact', tool: 'record_fact', dependsOn: [], input: { key: 'request', value, source, observedAt: '2026-10-27T00:00:00Z' } },
  { id: 'draft', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content: value, factStepId: 'fact' } }
];

test('two independent goals use the same durable plan executor across restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflows-'));
  const dbPath = join(dir, 'test.sqlite');
  let service = createService({ dbPath });
  try {
    const w = service.workflow;
    w.createGoal({ id: 'proposal-new', title: 'Proposal', owner: 'user', completion: 'Draft' });
    w.createGoal({ id: 'weekly', title: 'Weekly review', owner: 'user', completion: 'Report' });
    w.savePlan('proposal-new', 0, plan('outlook:1', 'proposal evidence'));
    w.savePlan('weekly', 0, plan('jira:2', 'weekly evidence'));
    assert.equal(w.runNext('proposal-new', 1).stepId, 'fact');
    assert.equal(w.runNext('weekly', 1).stepId, 'fact');
    service.close();
    service = createService({ dbPath });
    assert.equal(service.workflow.runNext('weekly', 1).stepId, 'draft');
    assert.equal(service.workflow.runNext('proposal-new', 1).stepId, 'draft');
    assert.equal(service.workflow.runNext('weekly', 1).status, 'complete');
    const a: any = service.workflow.inspect('proposal-new');
    const b: any = service.workflow.inspect('weekly');
    assert.equal(a.facts[0].source, 'outlook:1');
    assert.equal(b.facts[0].source, 'jira:2');
    assert.equal(a.artifacts[0].source_fact_id, a.facts[0].id);
    assert.equal(b.artifacts[0].source_fact_id, b.facts[0].id);
    assert.equal(b.artifacts[0].content, 'weekly evidence');
    assert.equal(service.state().goal.id, 'proposal');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('plans are versioned, validate dependencies, and reject stale execution', () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    const w = service.workflow;
    w.createGoal({ id: 'goal', title: 'Goal', owner: 'user', completion: 'Done' });
    assert.throws(() => w.runNext('goal', 0), /plan_not_found/);
    assert.throws(() => w.savePlan('goal', 0, [{ id: 'bad', tool: 'create_artifact', dependsOn: [], input: { kind: 'draft', content: 'x', factStepId: 'missing' } }]), /invalid_artifact/);
    assert.equal(w.savePlan('goal', 0, plan('source', 'one')), 1);
    assert.equal(w.savePlan('goal', 1, plan('source', 'two')), 2);
    assert.throws(() => w.savePlan('goal', 1, plan('source', 'three')), /stale_plan/);
    assert.throws(() => w.runNext('goal', 1), /stale_plan/);
    assert.equal((w.inspect('goal').plans as any[]).length, 2);
  } finally { service.close(); }
});

test('transitive fact dependencies are accepted while unrelated or non-fact references are rejected', () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    const w = service.workflow;
    w.createGoal({ id: 'graph', title: 'Graph', owner: 'local', completion: 'Done' });
    const fact = plan('source', 'one')[0];
    const next: WorkflowStep = { id: 'next', tool: 'record_fact', dependsOn: ['fact'], input: { key: 'other', value: 'two', source: 'source', observedAt: '2026-10-27T00:00:00Z' } };
    const draft: WorkflowStep = { id: 'draft', tool: 'create_artifact', dependsOn: ['next'], input: { kind: 'draft', content: 'review', factStepId: 'fact' } };
    const follow: WorkflowStep = { id: 'follow', tool: 'personal_followup', dependsOn: ['draft'], input: { taskKey: 'review', title: 'Review', factStepId: 'fact' } };
    assert.throws(() => w.savePlan('graph', 0, [fact, { ...next, dependsOn: [] }, draft]), /invalid_artifact/);
    assert.throws(() => w.savePlan('graph', 0, [fact, next, draft, { ...follow, input: { ...follow.input, factStepId: 'draft' } }]), /invalid_followup/);
    assert.throws(() => w.savePlan('graph', 0, [fact, { ...next, dependsOn: ['draft'] }, draft]), /invalid_step_dependencies/);
    const version = w.savePlan('graph', 0, [fact, next, draft, follow]);
    for (let i = 0; i < 4; i++) assert.equal(w.runNext('graph', version).status, 'progressed');
    assert.equal((w.inspect('graph').personalTasks as any[]).length, 1);
    assert.equal((w.inspect('graph').artifacts as any[])[0].source_fact_id, (w.inspect('graph').facts as any[])[0].id);
  } finally { service.close(); }
});

test('legacy proposal drafts and weekly reviews use isolated versioned workflows across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-legacy-'));
  const dbPath = join(dir, 'test.sqlite');
  let service = createService({ dbPath });
  try {
    service.ingest(fixtures[0]);
    assert.equal((await service.advanceGoal()).status, 'waiting');
    await service.advanceGoal();
    service.advanceClock('week');
    const firstDraft: any = service.state().latestDraft;
    const firstDigest: any = service.state().digests[0];
    const proposal: any = service.workflow.inspect('legacy:proposal');
    const weekly: any = service.workflow.inspect('legacy:weekly');
    assert.equal(proposal.plans.length, 1);
    assert.equal(proposal.artifacts[0].content, firstDraft.content);
    assert.equal(weekly.artifacts[0].content, firstDigest.content);
    assert.equal(proposal.artifacts[0].source_fact_id, proposal.facts[0].id);
    assert.equal(weekly.artifacts[0].source_fact_id, weekly.facts[0].id);
    assert.equal(JSON.parse(proposal.facts[0].value).dueDate, '2026-10-30');
    assert.equal(JSON.parse(weekly.facts[0].value).duplicateCount, 0);
    assert.equal(service.state().outcomes.length, 0);
    service.close();
    service = createService({ dbPath });
    assert.equal((service.workflow.inspect('legacy:proposal').plans as any[]).length, 1);
    service.ingest(fixtures[4]);
    await service.advanceGoal();
    service.advanceClock('week');
    const nextProposal: any = service.workflow.inspect('legacy:proposal');
    const nextWeekly: any = service.workflow.inspect('legacy:weekly');
    assert.deepEqual(nextProposal.plans.map((p: any) => p.version), [1, 2]);
    assert.deepEqual(nextWeekly.plans.map((p: any) => p.version), [1, 2]);
    assert.equal(nextProposal.artifacts[1].content, (service.state().latestDraft as any).content);
    assert.equal(nextWeekly.artifacts[1].content, (service.state().digests[0] as any).content);
    assert.equal(JSON.parse(nextProposal.facts[1].value).dueDate, '2026-10-29');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed weekly workflow rolls back clock, plan, and legacy digest together', () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    const previous = service.state().now;
    const runNext = service.workflow.runNext;
    let calls = 0;
    service.workflow.runNext = (...args) => {
      if (++calls === 2) throw new Error('injected_failure');
      return runNext(...args);
    };
    assert.throws(() => service.advanceClock('week'), /injected_failure/);
    assert.equal(service.state().now, previous);
    assert.equal(service.db.get<any>('SELECT value FROM kv WHERE key=?', ['clock']).value, previous);
    assert.equal(service.state().digests.length, 0);
    assert.equal(service.workflow.inspect('legacy:weekly').goal, undefined);
    service.workflow.runNext = runNext;
    service.advanceClock('week');
    assert.equal(service.state().digests.length, 1);
    assert.equal((service.workflow.inspect('legacy:weekly').plans as any[]).length, 1);
  } finally { service.close(); }
});

test('failed proposal workflow rolls back its legacy draft and approvals and can retry', async () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    service.ingestAll();
    const runNext = service.workflow.runNext;
    let calls = 0;
    service.workflow.runNext = (...args) => {
      if (++calls === 2) throw new Error('injected_failure');
      return runNext(...args);
    };
    await assert.rejects(service.advanceGoal(), /injected_failure/);
    assert.equal(service.state().latestDraft, undefined);
    assert.equal(service.state().approvals.length, 0);
    assert.equal(service.workflow.inspect('legacy:proposal').goal, undefined);
    service.workflow.runNext = runNext;
    assert.equal((await service.advanceGoal()).status, 'approval_required');
    assert.equal(service.state().approvals.length, 2);
    assert.equal(service.state().outcomes.length, 0);
  } finally { service.close(); }
});

test('planner proposals obey host schema, target authority and per-goal budgets', () => {
  const service = createService({ dbPath: ':memory:' });
  const policy: PlannerPolicy = { allowedSources: ['outlook:1'], trustedFacts: [{ source: 'outlook:1', key: 'request', value: 'evidence', observedAt: '2026-10-27T00:00:00Z' }, { source: 'outlook:1', key: 'request', value: 'replanned', observedAt: '2026-10-27T00:00:00Z' }], allowedArtifactKinds: ['draft'], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 100, maxPlanVersions: 2, maxPlannerAttempts: 3 };
  try {
    const w = service.workflow;
    for (const id of ['one', 'two', 'budget', 'unconfigured']) w.createGoal({ id, title: id, owner: 'user', completion: 'Done' });
    const good = plan('outlook:1', 'evidence');
    assert.throws(() => w.saveProposedPlan('unconfigured', 0, { steps: good }), /planner_policy_missing/);
    assert.throws(() => w.configurePlanner('one', 0, { ...policy, maxSteps: NaN }), /invalid_planner_policy/);
    assert.equal(w.configurePlanner('one', 0, policy), 1);
    assert.equal(w.configurePlanner('two', 0, policy), 1);
    assert.throws(() => w.configurePlanner('one', 0, policy), /stale_policy/);
    assert.throws(() => w.saveProposedPlan('one', 0, { steps: good, policy: {} }), /invalid_proposal_schema/);
    assert.throws(() => w.saveProposedPlan('one', 0, { steps: [{ ...good[0], injected: true }] }), /invalid_step_schema/);
    assert.throws(() => w.saveProposedPlan('one', 0, { steps: [{ ...good[0], input: { ...(good[0] as any).input, target: 'other' } }] }), /invalid_fact/);
    assert.throws(() => w.saveProposedPlan('one', 0, { steps: [{ ...good[0], tool: 'send_message' }] }), /unknown_tool/);
    assert.throws(() => w.saveProposedPlan('one', 0, { steps: plan('outlook:2', 'evidence') }), /source_not_authorized/);
    assert.throws(() => w.saveProposedPlan('one', 0, { steps: plan('outlook:1', 'forged evidence') }), /fact_not_verified/);
    assert.throws(() => w.saveProposedPlan('one', 0, { steps: [good[0], { ...good[1], input: { ...(good[1] as any).input, kind: 'shared-write' } }] }), /artifact_not_authorized/);
    w.configurePlanner('budget', 0, { ...policy, maxArtifactCalls: 0 });
    assert.throws(() => w.saveProposedPlan('budget', 0, { steps: good }), /planner_budget_exceeded/);
    w.configurePlanner('budget', 1, { ...policy, maxTextChars: 4 });
    assert.throws(() => w.saveProposedPlan('budget', 0, { steps: good }), /planner_budget_exceeded/);
    assert.throws(() => w.saveProposedPlan('one', 0, { steps: [good[0], good[0]] }), /invalid_step_dependencies/);
    assert.equal((w.inspect('one').plans as any[]).length, 0);
    assert.equal(w.saveProposedPlan('one', 0, { steps: good }), 1);
    assert.equal(w.saveProposedPlan('two', 0, { steps: good }), 1);
    assert.equal(w.runNext('one', 1).stepId, 'fact');
    assert.equal(w.saveProposedPlan('one', 1, { steps: plan('outlook:1', 'replanned') }), 2);
    assert.throws(() => w.runNext('one', 1), /stale_plan/);
    assert.throws(() => w.saveProposedPlan('one', 1, { steps: good }), /stale_plan/);
    assert.throws(() => w.saveProposedPlan('one', 2, { steps: good }), /planner_replan_budget_exceeded/);
    assert.equal(w.runNext('two', 1).stepId, 'fact');
    assert.equal((w.inspect('one').plans as any[]).length, 2);
    assert.equal((w.inspect('two').plans as any[]).length, 1);
  } finally { service.close(); }
});

test('planner authority persists across restart, is isolated, and is checked again at execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-authority-'));
  const dbPath = join(dir, 'test.sqlite');
  const policy: PlannerPolicy = { allowedSources: ['outlook:1'], trustedFacts: [{ source: 'outlook:1', key: 'request', value: 'evidence', observedAt: '2026-10-27T00:00:00Z' }], allowedArtifactKinds: ['draft'], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 100, maxPlanVersions: 3, maxPlannerAttempts: 3 };
  let service = createService({ dbPath });
  try {
    for (const id of ['one', 'two']) {
      service.workflow.createGoal({ id, title: id, owner: 'user', completion: 'Done' });
      service.workflow.configurePlanner(id, 0, policy);
      service.workflow.saveProposedPlan(id, 0, { steps: plan('outlook:1', 'evidence') });
      service.workflow.runNext(id, 1);
    }
    service.workflow.configurePlanner('one', 1, { ...policy, allowedSources: [] });
    service.close();
    service = createService({ dbPath });
    assert.throws(() => service.workflow.runNext('one', 1), /stale_policy/);
    assert.equal(service.workflow.runNext('two', 1).stepId, 'draft');
    service.workflow.configurePlanner('one', 2, policy);
    service.workflow.saveProposedPlan('one', 1, { steps: plan('outlook:1', 'evidence') });
    service.db.run('UPDATE workflow_steps SET input_json=? WHERE goal_id=? AND plan_version=? AND step_id=?', [JSON.stringify({ key: 'request', value: 'forged', source: 'outlook:1', observedAt: '2026-10-27T00:00:00Z' }), 'one', 2, 'fact']);
    assert.throws(() => service.workflow.runNext('one', 2), /fact_not_verified/);
    assert.equal((service.workflow.inspect('one').artifacts as any[]).length, 0);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('host builds planner authority from scoped trusted evidence and detects changes after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-evidence-'));
  const dbPath = join(dir, 'test.sqlite');
  let service = createService({ dbPath });
  try {
    service.ingest(fixtures[0]);
    service.ingest(fixtures[6]);
    service.ingest(fixtures[8]);
    const w = service.workflow;
    for (const id of ['proposal-evidence', 'beta-evidence']) w.createGoal({ id, title: id, owner: 'user', completion: 'Done' });
    w.bindProject('proposal-evidence', fixtures[0].project);
    w.bindProject('proposal-evidence', fixtures[0].project);
    assert.throws(() => w.bindProject('proposal-evidence', fixtures[6].project), /project_already_bound/);
    w.bindProject('beta-evidence', fixtures[6].project);
    const limits = { allowedArtifactKinds: ['draft'], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 2000, maxPlanVersions: 3, maxPlannerAttempts: 3 };
    const proposal = w.configurePlannerFromEvidence('proposal-evidence', 0, limits);
    const beta = w.configurePlannerFromEvidence('beta-evidence', 0, limits);
    assert.equal(proposal.facts.length, 1);
    assert.equal(beta.facts.length, 1);
    assert.equal(proposal.facts[0].source, 'outlook:outlook-001');
    assert.equal(beta.facts[0].source, 'teams:teams-004');
    const stepsFor = (fact: typeof proposal.facts[number]): WorkflowStep[] => [
      { id: 'fact', tool: 'record_fact', dependsOn: [], input: fact },
      { id: 'draft', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content: 'review', factStepId: 'fact' } }
    ];
    assert.throws(() => w.saveProposedPlan('proposal-evidence', 0, { steps: stepsFor(beta.facts[0]) }), /source_not_authorized/);
    w.saveProposedPlan('proposal-evidence', 0, { steps: stepsFor(proposal.facts[0]) });
    w.saveProposedPlan('beta-evidence', 0, { steps: stepsFor(beta.facts[0]) });
    w.runNext('proposal-evidence', 1);
    w.runNext('beta-evidence', 1);
    service.db.run('UPDATE evidence SET trusted=0 WHERE id=?', [Number(proposal.facts[0].key.split(':')[1])]);
    service.close();
    service = createService({ dbPath });
    assert.throws(() => service.workflow.runNext('proposal-evidence', 1), /stale_evidence/);
    assert.equal(service.workflow.runNext('beta-evidence', 1).stepId, 'draft');
    assert.equal((service.workflow.inspect('proposal-evidence').artifacts as any[]).length, 0);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('injected planner receives scoped facts and cannot save a forged or outdated proposal', async () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    service.ingest(fixtures[0]);
    service.ingest(fixtures[6]);
    const w = service.workflow;
    const limits = { allowedArtifactKinds: ['draft'], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 2000, maxPlanVersions: 2, maxPlannerAttempts: 3 };
    for (const id of ['good', 'forged', 'policy-race', 'evidence-race']) {
      w.createGoal({ id, title: id, owner: 'user', completion: 'Done' });
      w.bindProject(id, fixtures[0].project);
      w.configurePlannerFromEvidence(id, 0, limits);
    }
    const makePlan = (fact: { source: string; key: string; value: string; observedAt: string }): WorkflowStep[] => [
      { id: 'fact', tool: 'record_fact', dependsOn: [], input: fact },
      { id: 'draft', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content: 'review', factStepId: 'fact' } }
    ];
    assert.equal(await w.planWithAdapter('good', 0, async input => {
      assert.equal(input.goal.id, 'good');
      assert.equal(input.facts.length, 1);
      assert.equal(input.facts[0].source, 'outlook:outlook-001');
      return { steps: makePlan(input.facts[0]) };
    }), 1);
    await assert.rejects(w.planWithAdapter('forged', 0, async input => {
      input.facts[0].value = 'invented';
      return { steps: makePlan(input.facts[0]) };
    }), /fact_not_verified/);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = w.planWithAdapter('policy-race', 0, async input => { entered(); await gate; return { steps: makePlan(input.facts[0]) }; });
    await started;
    w.configurePlannerFromEvidence('policy-race', 1, limits);
    release();
    await assert.rejects(pending, /stale_policy/);
    await assert.rejects(w.planWithAdapter('evidence-race', 0, async input => {
      service.db.run('UPDATE evidence SET trusted=0 WHERE id=?', [Number(input.facts[0].key.split(':')[1])]);
      return { steps: makePlan(input.facts[0]) };
    }), /stale_evidence/);
    assert.equal((w.inspect('forged').plans as any[]).length, 0);
    assert.equal((w.inspect('policy-race').plans as any[]).length, 0);
    assert.equal((w.inspect('evidence-race').plans as any[]).length, 0);
  } finally { service.close(); }
});

test('failed and interrupted planner calls consume a durable per-goal attempt budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-attempts-'));
  const dbPath = join(dir, 'test.sqlite');
  const policy: PlannerPolicy = { allowedSources: [], trustedFacts: [], allowedArtifactKinds: [], maxSteps: 2, maxFactCalls: 1, maxArtifactCalls: 1, maxTextChars: 100, maxPlanVersions: 3, maxPlannerAttempts: 1 };
  let service = createService({ dbPath });
  try {
    for (const id of ['failed', 'interrupted']) {
      service.workflow.createGoal({ id, title: id, owner: 'user', completion: 'Done' });
      service.workflow.configurePlanner(id, 0, policy);
    }
    await assert.rejects(service.workflow.planWithAdapter('failed', 0, async () => { throw new Error('injected_failure'); }), /planner_unknown_failure/);
    // Simulate a process crash after reservation without leaving a live timer.
    service.db.run("INSERT INTO workflow_planner_attempts(goal_id,policy_version,status,created_at) VALUES('interrupted',1,'running',?)", ['2026-10-27T00:00:00Z']);
    assert.equal(service.db.get<any>("SELECT status FROM workflow_planner_attempts WHERE goal_id='interrupted'").status, 'running');
    service.close();
    service = createService({ dbPath });
    service.workflow.configurePlanner('failed', 1, policy);
    let calls = 0;
    for (const id of ['failed', 'interrupted']) {
      await assert.rejects(service.workflow.planWithAdapter(id, 0, async () => { calls++; return {}; }), /planner_attempt_budget_exceeded/);
    }
    assert.equal(calls, 0);
    assert.equal(service.db.get<any>("SELECT status FROM workflow_planner_attempts WHERE goal_id='failed'").status, 'failed');
    assert.equal(service.db.get<any>("SELECT status FROM workflow_planner_attempts WHERE goal_id='interrupted'").status, 'running');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});
