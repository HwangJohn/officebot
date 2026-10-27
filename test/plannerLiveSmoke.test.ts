import test from 'node:test';
import assert from 'node:assert/strict';
import { runPlannerSmoke } from '../scripts/planner-live-smoke.js';

test('live planner smoke harness exercises two goals and event replan with an injected fake', async () => {
  const result = await runPlannerSmoke(() => async input => ({ steps: [
    { id: 'source', dependsOn: [], tool: 'record_fact', input: input.facts[0] },
    { id: 'draft', dependsOn: ['source'], tool: 'create_artifact', input: { kind: 'draft', content: `Review: ${input.facts[0].value}`, factStepId: 'source' } }
  ] }));
  assert.deepEqual(result, { ok: true, goals: 2, eventReplanned: true, restart: true, externalEffects: 0 });
});
