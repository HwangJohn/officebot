import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPlannerAdapter } from '../src/modelPlanner.js';
import { runExpandedPlannerSmoke } from '../scripts/expanded-planner-live-smoke.js';

test('expanded live smoke exercises the schema with a fake transport and no external effects', async () => {
  const adapter = createModelPlannerAdapter(async prompt => {
    const context = JSON.parse(prompt.split('\n').at(-1)!);
    const facts = context.facts.slice(0, 4);
    const steps: any[] = facts.map((fact: any, index: number) => ({ id: `fact${index}`, tool: 'record_fact', dependsOn: [], input: { key: fact.key } }));
    steps.push({ id: 'task', tool: 'personal_followup', dependsOn: ['fact0'], input: { taskKey: 'review', title: 'Review local task', factStepId: 'fact0' } });
    steps.push({ id: 'draft', tool: 'create_artifact', dependsOn: ['fact0'], input: { kind: 'draft', content: facts.map((fact: any) => fact.value).join('\n'), factStepId: 'fact0' } });
    if (context.goal.title === 'Prepare proposal review' && !facts.some((fact: any) => fact.value.includes('QUOTE-12'))) steps.push({ id: 'wait', tool: 'wait_for_mock_record', dependsOn: ['fact0'], input: { source: 'outlook', account: 'mock:primary', externalId: 'vendor-quote' } });
    return { steps };
  });
  const result = await runExpandedPlannerSmoke(() => adapter);
  assert.deepEqual(result, { ok: true, goals: 2, mockSources: 4, waiting: true, correctionAndQuoteReplan: true, restart: true, localFollowups: true, externalEffects: 0 });
});
