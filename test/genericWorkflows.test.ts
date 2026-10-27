import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/core.js';
import { createModelPlannerAdapter } from '../src/modelPlanner.js';

test('an unavailable wait does not block ready independent branches or release dependent work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-branches-')), dbPath = join(dir, 'test.sqlite');
  const planner = createModelPlannerAdapter(async prompt => {
    const context = JSON.parse(prompt.split('\n').at(-1)!);
    return { steps: [
      { id: 'source', tool: 'record_fact', dependsOn: [], input: { key: context.facts[0].key } },
      { id: 'wait', tool: 'wait_for_mock_record', dependsOn: ['source'], input: { source: 'outlook', account: 'mock:primary', externalId: 'quote' } },
      { id: 'after-wait', tool: 'create_artifact', dependsOn: ['source', 'wait'], input: { kind: 'draft', content: 'After the quote', factStepId: 'source' } },
      { id: 'follow', tool: 'personal_followup', dependsOn: ['source'], input: { taskKey: 'review', title: 'Review locally', factStepId: 'source' } },
      { id: 'draft', tool: 'create_artifact', dependsOn: ['source'], input: { kind: 'draft', content: 'Before the quote', factStepId: 'source' } }
    ] };
  });
  let service = createService({ dbPath, plannerAdapterFactory: () => planner });
  const event = (project: string, externalId: string) => ({ source: 'outlook', account: 'mock:primary', project, externalId, revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert', details: { subject: 'Quote', body: 'Local mock' } });
  try {
    service.mockConnectors.ingest({ source: 'teams', account: 'mock:primary', project: 'proposal', externalId: 'request', revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert', details: { channel: 'proposal', text: 'Review proposal' } });
    const goal = service.createWorkspaceGoal({ project: 'proposal', title: 'Review', completion: 'Wait for quote and review locally' });
    await service.planWorkspaceGoal(goal.id, 0);
    assert.equal(service.runWorkspaceGoal(goal.id, 1).stepId, 'source');
    assert.equal(service.runWorkspaceGoal(goal.id, 1).stepId, 'follow');
    assert.equal(service.runWorkspaceGoal(goal.id, 1).stepId, 'draft');
    assert.equal(service.runWorkspaceGoal(goal.id, 1).status, 'waiting');
    let state: any = service.inspectWorkspaceGoal(goal.id);
    assert.equal(state.steps.find((step: any) => step.step_id === 'wait').status, 'waiting');
    assert.equal(state.steps.find((step: any) => step.step_id === 'after-wait').status, 'pending');
    assert.deepEqual(state.artifacts.map((item: any) => item.content), ['Before the quote']);
    service.mockConnectors.ingest(event('other-project', 'quote'));
    service.close(); service = createService({ dbPath, plannerAdapterFactory: () => planner });
    assert.equal(service.runWorkspaceGoal(goal.id, 1).status, 'waiting');
    service.mockConnectors.ingest(event('proposal', 'quote'));
    assert.equal(service.runWorkspaceGoal(goal.id, 1).stepId, 'wait');
    assert.equal(service.runWorkspaceGoal(goal.id, 1).stepId, 'after-wait');
    assert.equal(service.runWorkspaceGoal(goal.id, 1).status, 'complete');
    state = service.inspectWorkspaceGoal(goal.id);
    assert.equal(state.personalTasks.length, 1);
    assert.deepEqual(state.artifacts.map((item: any) => item.content), ['Before the quote', 'After the quote']);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('two model-proposed local workflows wait, replan and isolate four mock sources across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'generic-workflows-')), dbPath = join(dir, 'test.sqlite');
  let time = Date.parse('2026-10-27T09:00:00Z');
  const prompts: any[] = [];
  const planner = createModelPlannerAdapter(async prompt => {
    const context = JSON.parse(prompt.split('\n').at(-1)!); prompts.push(context);
    const fact = context.facts.find((item: any) => item.value.includes('approved-quote')) ?? context.facts[0];
    const steps: any[] = [
      { id: 'source', tool: 'record_fact', dependsOn: [], input: { key: fact.key } },
      { id: 'followup', tool: 'personal_followup', dependsOn: ['source'], input: { taskKey: 'review-next', title: 'Review the sourced next step', factStepId: 'source' } },
      { id: 'draft', tool: 'create_artifact', dependsOn: ['source'], input: { kind: 'draft', content: `Draft: ${fact.value}`, factStepId: 'source' } }
    ];
    if (context.goal.completion.includes('vendor-quote') && !context.facts.some((item: any) => item.value.includes('approved-quote'))) steps.push({ id: 'quote', tool: 'wait_for_mock_record', dependsOn: ['source'], input: { source: 'outlook', account: 'mock:primary', externalId: 'vendor-quote' } });
    return { steps };
  });
  let service = createService({ dbPath, plannerAdapterFactory: () => planner, schedulerClock: () => time });
  const event = (project: string, externalId: string, source: string, details: unknown, revision = 1) => ({ source, account: 'mock:primary', project, externalId, revision, occurredAt: `2026-10-27T09:00:0${revision}Z`, operation: 'upsert', details });
  try {
    service.mockConnectors.ingest(event('proposal', 'request', 'teams', { channel: 'proposal', text: 'Proposal request: await vendor quote' }));
    service.mockConnectors.ingest(event('proposal', 'policy', 'confluence', { pageId: 'policy', title: 'Proposal policy', body: 'Use approved policy' }));
    service.mockConnectors.ingest(event('weekly', 'issue', 'jira', { issueKey: 'W-1', status: 'blocked', summary: 'Weekly issue' }));
    service.mockConnectors.ingest(event('weekly', 'decisions', 'teams', { channel: 'weekly', text: 'Weekly decision review' }));
    const proposal = service.createWorkspaceGoal({ project: 'proposal', title: 'Proposal review', completion: 'Review vendor-quote' });
    const weekly = service.createWorkspaceGoal({ project: 'weekly', title: 'Weekly review', completion: 'Review issues and decisions' });
    await service.planWorkspaceGoal(proposal.id, 0); await service.planWorkspaceGoal(weekly.id, 0);
    for (let i = 0; i < 3; i++) assert.equal(service.runWorkspaceGoal(proposal.id, 1).status, 'progressed');
    assert.equal(service.runWorkspaceGoal(proposal.id, 1).status, 'waiting');
    for (let i = 0; i < 3; i++) assert.equal(service.runWorkspaceGoal(weekly.id, 1).status, 'progressed');
    assert.equal(service.runWorkspaceGoal(weekly.id, 1).status, 'complete');
    let p: any = service.inspectWorkspaceGoal(proposal.id), w: any = service.inspectWorkspaceGoal(weekly.id);
    assert.equal(p.personalTasks.length, 1); assert.equal(w.personalTasks.length, 1);
    assert.equal(p.steps.find((s: any) => s.step_id === 'quote').status, 'waiting');
    assert.ok(!JSON.stringify(prompts.find(c => c.goal.id === weekly.id)).includes('Proposal request'));
    service.mockConnectors.ingest(event('weekly', 'vendor-quote', 'outlook', { subject: 'Other project', body: 'approved-quote in wrong project' }));
    assert.equal(service.runWorkspaceGoal(proposal.id, 1).status, 'waiting');
    service.close(); service = createService({ dbPath, plannerAdapterFactory: () => planner, schedulerClock: () => time });
    assert.equal(service.runWorkspaceGoal(proposal.id, 1).status, 'waiting');
    const corrected = service.mockConnectors.ingest(event('proposal', 'request', 'teams', { channel: 'proposal', text: 'Corrected proposal deadline' }, 2));
    const quote = service.mockConnectors.ingest(event('proposal', 'vendor-quote', 'outlook', { subject: 'Quote', body: 'approved-quote received' }));
    assert.equal(corrected.latest, true); assert.equal(quote.latest, true);
    await service.automation.tick();
    p = service.inspectWorkspaceGoal(proposal.id); w = service.inspectWorkspaceGoal(weekly.id);
    assert.ok(p.goal.current_plan >= 2);
    assert.equal(p.steps.filter((s: any) => s.plan_version === p.goal.current_plan && s.status !== 'complete').length, 0);
    assert.equal(p.personalTasks.length, 1);
    assert.ok(p.artifacts.some((a: any) => a.content.includes('approved-quote')));
    const proposalFacts = prompts.filter(c => c.goal.id === proposal.id).flatMap(c => c.facts.map((f: any) => f.value));
    assert.ok(!proposalFacts.includes('Weekly issue (blocked)'));
    const artifact = p.artifacts.find((a: any) => a.plan_version === p.goal.current_plan);
    const approval = service.workspaceApprovals.create(proposal.id, artifact.id, quote.eventId);
    assert.equal(service.workspaceApprovals.outcomes(proposal.id).length, 0);
    assert.equal(service.workspaceApprovals.decide(proposal.id, approval.id, 'approve', { kind: 'local', id: 'local' }).status, 'executed');
    assert.equal(service.workspaceApprovals.decide(proposal.id, approval.id, 'approve', { kind: 'local', id: 'local' }).status, 'already_executed');
    assert.equal(service.workspaceApprovals.outcomes(proposal.id).length, 1);
    assert.equal(service.workspaceApprovals.outcomes(weekly.id).length, 0);
    const task = service.inspectWorkspaceGoal(weekly.id).personalTasks[0] as any;
    assert.throws(() => service.completeWorkspacePersonalTask(proposal.id, task.id, task.plan_version), /personal_task_not_found/);
    assert.throws(() => service.completeWorkspacePersonalTask(weekly.id, task.id, task.plan_version + 1), /stale_personal_task/);
    assert.equal(service.completeWorkspacePersonalTask(weekly.id, task.id, task.plan_version).status, 'completed');
    assert.equal(service.completeWorkspacePersonalTask(weekly.id, task.id, task.plan_version).status, 'already_completed');
    const before = service.inspectWorkspaceGoal(weekly.id).personalTasks[0] as any;
    service.close(); service = createService({ dbPath, plannerAdapterFactory: () => planner, schedulerClock: () => time });
    service.mockConnectors.ingest(event('weekly', 'issue', 'jira', { issueKey: 'W-1', status: 'blocked', summary: 'Updated weekly issue' }, 2));
    await service.automation.tick();
    const advanced = service.inspectWorkspaceGoal(weekly.id) as any;
    assert.ok(advanced.goal.current_plan > task.plan_version);
    const latestSteps = advanced.steps.filter((step: any) => step.plan_version === advanced.goal.current_plan);
    assert.ok(latestSteps.every((step: any) => step.status === 'complete'));
    assert.equal(JSON.parse(latestSteps.find((step: any) => step.tool === 'personal_followup').result_json).alreadyCompleted, true);
    assert.deepEqual(advanced.personalTasks[0], before);
    assert.equal(service.db.get<{ n: number }>('SELECT count(*) AS n FROM workflow_personal_task_completions WHERE task_id=?', [task.id])?.n, 1);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('planner cannot introduce real accounts, unsupported tools or excess local follow-ups', async () => {
  let mode = 'real-account';
  const planner = createModelPlannerAdapter(async prompt => {
    const context = JSON.parse(prompt.split('\n').at(-1)!);
    const fact = { id: 'source', tool: 'record_fact', dependsOn: [], input: { key: context.facts[0].key } };
    if (mode === 'real-account') return { steps: [fact, { id: 'wait', tool: 'wait_for_mock_record', dependsOn: ['source'], input: { source: 'outlook', account: 'company:real', externalId: 'quote' } }] };
    if (mode === 'forged-tool') return { steps: [fact, { id: 'send', tool: 'send_email', dependsOn: ['source'], input: {} }] };
    return { steps: [fact, ...Array.from({ length: 3 }, (_, i) => ({ id: `follow${i}`, tool: 'personal_followup', dependsOn: ['source'], input: { taskKey: `key${i}`, title: 'Local task', factStepId: 'source' } }))] };
  });
  const service = createService({ dbPath: ':memory:', plannerAdapterFactory: () => planner });
  try {
    service.mockConnectors.ingest({ source: 'teams', account: 'mock:primary', project: 'safe', externalId: 'one', revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert', details: { channel: 'safe', text: 'Evidence' } });
    const goal = service.createWorkspaceGoal({ project: 'safe', title: 'Review', completion: 'Inspect' });
    for (mode of ['real-account', 'forged-tool', 'over-budget']) {
      await assert.rejects(service.planWorkspaceGoal(goal.id, 0));
      assert.equal(service.inspectWorkspaceGoal(goal.id).plans.length, 0);
      assert.equal(service.inspectWorkspaceGoal(goal.id).personalTasks.length, 0);
    }
  } finally { service.close(); }
});

test('planner sees local task state, rejects a completion race and cannot reuse a completed key for different work', async () => {
  let block = false, different = false, release!: () => void, entered!: () => void;
  let seen: any;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const planner = createModelPlannerAdapter(async prompt => {
    const context = JSON.parse(prompt.split('\n').at(-1)!); seen = context.personalTasks;
    if (block) { entered(); await gate; }
    return { steps: [
      { id: 'source', tool: 'record_fact', dependsOn: [], input: { key: context.facts[0].key } },
      { id: 'follow', tool: 'personal_followup', dependsOn: ['source'], input: { taskKey: 'review', title: different ? 'A different task' : 'Review the item', factStepId: 'source' } }
    ] };
  });
  const service = createService({ dbPath: ':memory:', plannerAdapterFactory: () => planner });
  try {
    service.mockConnectors.ingest({ source: 'teams', account: 'mock:primary', project: 'safe', externalId: 'one', revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert', details: { channel: 'safe', text: 'Evidence' } });
    const goal = service.createWorkspaceGoal({ project: 'safe', title: 'Review', completion: 'Inspect' });
    await service.planWorkspaceGoal(goal.id, 0); service.runWorkspaceGoal(goal.id, 1); service.runWorkspaceGoal(goal.id, 1);
    const task = service.inspectWorkspaceGoal(goal.id).personalTasks[0] as any;
    block = true;
    const pending = service.planWorkspaceGoal(goal.id, 1); await started;
    assert.equal(seen[0].status, 'open');
    service.completeWorkspacePersonalTask(goal.id, task.id, task.plan_version);
    release(); await assert.rejects(pending, /stale_personal_task/);
    block = false; different = true;
    const newPlan = await service.planWorkspaceGoal(goal.id, 1);
    assert.equal(seen[0].status, 'done');
    service.runWorkspaceGoal(goal.id, newPlan.version);
    assert.throws(() => service.runWorkspaceGoal(goal.id, newPlan.version), /completed_personal_task_conflict/);
    assert.equal((service.inspectWorkspaceGoal(goal.id).personalTasks[0] as any).title, 'Review the item');
    assert.equal((service.inspectWorkspaceGoal(goal.id).personalTasks[0] as any).status, 'done');
  } finally { release(); service.close(); }
});
