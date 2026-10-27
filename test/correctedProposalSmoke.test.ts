import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPlannerAdapter } from '../src/modelPlanner.js';
import { runCorrectedProposalSmoke } from '../scripts/corrected-proposal-smoke.js';

test('corrected proposal smoke requires actual amount, deadline and sourced draft', async () => {
  let calls = 0; let mode: 'valid' | 'missing' | 'last-bad' | 'false-missing' = 'valid';
  const factory = () => createModelPlannerAdapter(async prompt => {
    calls++; const ctx = JSON.parse(prompt.split('\n').at(-1)!);
    const record = ctx.currentRecords.records.find((r: any) => r.externalId === 'vendor-quote');
    assert.equal(record.source, 'outlook'); assert.equal(record.account, 'mock:acceptance');
    const fact = ctx.facts.find((f: any) => f.key === record.factKey);
    return { steps: [
      { id: 'fact', tool: 'record_fact', dependsOn: [], input: { key: fact.key } },
      { id: 'draft', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content: mode === 'missing' ? 'DEADLINE-FRIDAY, update quote later' : mode === 'false-missing' ? 'DEADLINE-FRIDAY; quote of 12 units is missing' : fact.value, factStepId: 'fact' } },
      ...(mode === 'last-bad' ? [{ id: 'draft-later', tool: 'create_artifact', dependsOn: ['fact'], input: { kind: 'draft', content: 'DEADLINE-FRIDAY, replace the vendor quote later', factStepId: 'fact' } }] : []),
      { id: 'task', tool: 'personal_followup', dependsOn: ['fact'], input: { taskKey: ctx.personalTasks[0].taskKey, title: 'Review local proposal', factStepId: 'fact' } }
    ] };
  });
  assert.deepEqual(await runCorrectedProposalSmoke(factory), { ok: true, hasAmount: true, hasDeadline: true, futurePlaceholder: false, sourceLinked: true, openTasks: 1, noSharedEffects: true, modelCalls: 1 });
  mode = 'missing';
  const result = await runCorrectedProposalSmoke(factory); assert.equal(result.ok, false); assert.equal('hasAmount' in result && result.hasAmount, false);
  mode = 'last-bad';
  let evidence: any;
  const later = await runCorrectedProposalSmoke(factory, value => { evidence = value; }); assert.equal(later.ok, false); assert.equal('hasAmount' in later && later.hasAmount, false);
  assert.equal(evidence.finalDraft, 'DEADLINE-FRIDAY, replace the vendor quote later');
  assert.deepEqual(evidence.tasks, [{ taskKey: 'review-draft', title: 'Review local proposal', status: 'open' }]);
  assert.equal(evidence.signals.instruction, true);
  mode = 'false-missing';
  const falseMissing = await runCorrectedProposalSmoke(factory); assert.equal(falseMissing.ok, false); assert.equal('futurePlaceholder' in falseMissing && falseMissing.futurePlaceholder, true);
  assert.equal(calls, 4);
});

test('synthetic evidence redacts detected secrets and excludes thrown model errors', async () => {
  const secretLike = 'sk-' + 'synthetic'.repeat(3); let evidence: any;
  const adapter = createModelPlannerAdapter(async prompt => {
    const ctx = JSON.parse(prompt.split('\n').at(-1)!);
    const key = ctx.currentRecords.records.find((r: any) => r.externalId === 'vendor-quote').factKey;
    return { steps: [
      { id: 'f', tool: 'record_fact', dependsOn: [], input: { key } },
      { id: 'd', tool: 'create_artifact', dependsOn: ['f'], input: { kind: 'draft', content: `DEADLINE-FRIDAY 12 units ${secretLike}`, factStepId: 'f' } },
      { id: 't', tool: 'personal_followup', dependsOn: ['f'], input: { taskKey: 'review-draft', title: `Review ${secretLike}`, factStepId: 'f' } }
    ] };
  });
  await runCorrectedProposalSmoke(() => adapter, value => { evidence = value; });
  assert.ok(!JSON.stringify(evidence).includes(secretLike));
  assert.match(evidence.finalDraft, /12 units/);
  assert.match(evidence.tasks[0].title, /\[비밀 값 삭제\]/);
  let captured = false;
  const failing = createModelPlannerAdapter(async () => { throw new Error(secretLike); });
  const result = await runCorrectedProposalSmoke(() => failing, () => { captured = true; });
  assert.equal(captured, false); assert.ok(!JSON.stringify(result).includes(secretLike));
});
