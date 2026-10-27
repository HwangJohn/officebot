import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPlannerAdapter } from '../src/modelPlanner.js';
import { runThreeFactPlannerSmoke } from '../scripts/three-fact-planner-smoke.js';

test('three-fact smoke runs one synthetic plan and reports bounded diagnostics on rejection', async () => {
  let calls = 0;
  const adapter = createModelPlannerAdapter(async prompt => {
    calls++;
    assert.match(prompt, /literal prefix mock:/);
    assert.match(prompt, /Do not invent or modify any part of the record identity/);
    const input = JSON.parse(prompt.split('\n').at(-1)!);
    assert.equal(input.facts.length, 3);
    return { steps: [
      { id: 'fact', tool: 'record_fact', dependsOn: [], input: { key: input.facts[0].key } },
      { id: 'wait', tool: 'wait_for_mock_record', dependsOn: ['fact'], input: { source: 'outlook', account: 'mock:acceptance', externalId: 'vendor-quote' } },
      { id: 'task', tool: 'personal_followup', dependsOn: ['fact'], input: { taskKey: 'review', title: 'Review', factStepId: 'fact' } },
      { id: 'draft', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content: 'Review', factStepId: 'fact' } }
    ] };
  });
  assert.deepEqual(await runThreeFactPlannerSmoke(() => adapter), { ok: true, factCount: 3, stepCount: 4, exactWait: true, localTask: true, localDraft: true, externalEffects: 0, attempts: 1 });
  assert.equal(calls, 1);
  const invalid = createModelPlannerAdapter(async () => ({ steps: [{ id: 'f', tool: 'record_fact', dependsOn: [], input: { key: 'unverified' } }] }));
  assert.deepEqual(await runThreeFactPlannerSmoke(() => invalid), { ok: false, code: 'fact_not_verified', attempts: 1 });
});

test('wait target validation rejects malformed inputs without leaking values and smoke requires exact identity', async () => {
  const run = async (input: { source: string; account: string; externalId: string }) => runThreeFactPlannerSmoke(() => createModelPlannerAdapter(async prompt => {
    const context = JSON.parse(prompt.split('\n').at(-1)!);
    return { steps: [
      { id: 'fact', tool: 'record_fact', dependsOn: [], input: { key: context.facts[0].key } },
      { id: 'wait', tool: 'wait_for_mock_record', dependsOn: [], input },
      { id: 'task', tool: 'personal_followup', dependsOn: ['fact'], input: { taskKey: 'review', title: 'Review', factStepId: 'fact' } },
      { id: 'draft', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content: 'Review', factStepId: 'fact' } }
    ] };
  }));
  const badAccount = await run({ source: 'outlook', account: 'private-invalid-account', externalId: 'vendor-quote' });
  assert.deepEqual(badAccount, { ok: false, code: 'invalid_wait', attempts: 1, waitShape: { count: 1, sourceExact: true, accountFormat: false, accountExact: false, externalIdValid: true, externalIdExact: true } });
  assert.doesNotMatch(JSON.stringify(badAccount), /private-invalid-account/);
  const badId = await run({ source: 'outlook', account: 'mock:acceptance', externalId: '   ' });
  assert.deepEqual(badId, { ok: false, code: 'invalid_wait', attempts: 1, waitShape: { count: 1, sourceExact: true, accountFormat: true, accountExact: true, externalIdValid: false, externalIdExact: false } });
  for (const input of [
    { source: 'teams', account: 'mock:acceptance', externalId: 'vendor-quote' },
    { source: 'outlook', account: 'mock:other', externalId: 'vendor-quote' },
    { source: 'outlook', account: 'mock:acceptance', externalId: 'other' }
  ]) {
    const result = await run(input);
    assert.equal(result.ok, false);
    assert.equal('exactWait' in result && result.exactWait, false);
  }
});
