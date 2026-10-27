import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createService } from '../src/core.js';
import { PlannerAttemptFailure } from '../src/plannerDiagnostics.js';
import { createOpenAIPlannerAdapter } from '../src/modelPlanner.js';
import type { PlannerAdapter } from '../src/workflow.js';

// One bounded initial planner call, isolated SQLite, synthetic mocks only.
export async function runThreeFactPlannerSmoke(plannerAdapterFactory?: () => PlannerAdapter) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-three-fact-'));
  let waitShape: { count: number; sourceExact: boolean; accountFormat: boolean; accountExact: boolean; externalIdValid: boolean; externalIdExact: boolean } | undefined;
  const observeAdapter = (): PlannerAdapter => {
    const adapter = plannerAdapterFactory ? plannerAdapterFactory() : createOpenAIPlannerAdapter();
    return async context => {
      const proposal: any = await adapter(context);
      const waits = Array.isArray(proposal?.steps) ? proposal.steps.filter((step: any) => step?.tool === 'wait_for_mock_record') : [];
      if (waits.length) {
        const input = waits[0]?.input;
        waitShape = { count: Math.min(waits.length, 3), sourceExact: input?.source === 'outlook', accountFormat: typeof input?.account === 'string' && /^mock:[a-zA-Z0-9_-]{1,80}$/.test(input.account), accountExact: input?.account === 'mock:acceptance', externalIdValid: typeof input?.externalId === 'string' && input.externalId.trim().length > 0 && input.externalId.length <= 200, externalIdExact: input?.externalId === 'vendor-quote' };
      }
      return proposal;
    };
  };
  const service = createService({ dbPath: join(dir, 'isolated.sqlite'), engine: plannerAdapterFactory ? 'offline' : 'openai', plannerAdapterFactory: observeAdapter, plannerTimeoutMs: 50_000 });
  try {
    const project = 'SYNTHETIC-acceptance-smoke-proposal', account = 'mock:acceptance';
    const event = (source: string, externalId: string, details: unknown) => ({ source, account, project, externalId, revision: 1, occurredAt: '2026-10-27T09:00:00.000Z', operation: 'upsert', details });
    service.mockConnectors.ingest(event('teams', 'request', { channel: 'synthetic-proposal', text: 'SYNTHETIC: prepare proposal; vendor quote is still missing.' }));
    service.mockConnectors.ingest(event('confluence', 'policy', { pageId: 'synthetic-policy', title: 'SYNTHETIC proposal policy', body: 'Draft locally and wait for the vendor quote.' }));
    service.mockConnectors.ingest(event('outlook', 'planning-note', { subject: 'SYNTHETIC planning note', body: 'The vendor quote is not yet available.' }));
    const goal = service.createWorkspaceGoal({ project, title: '[SYNTHETIC smoke] Proposal review', completion: `Create a local proposal draft and personal follow-up, then wait for the exact missing Outlook record account ${account}, external ID vendor-quote. After it arrives, use the corrected deadline and quote. Never send anything.` });
    try { await service.planWorkspaceGoal(goal.id, 0); }
    catch (error) { const code = error instanceof PlannerAttemptFailure ? error.code : 'planner_unknown_failure'; return { ok: false, code, attempts: service.workflow.inspect(goal.id).plannerAttempts.length, ...(code === 'invalid_wait' && waitShape ? { waitShape } : {}) }; }
    const detail: any = service.inspectWorkspaceGoal(goal.id);
    const policy = service.db.get<{ policy_json: string }>('SELECT policy_json FROM workflow_planner_policies WHERE goal_id=? ORDER BY version DESC LIMIT 1', [goal.id]);
    const factCount = JSON.parse(policy!.policy_json).trustedFacts.length;
    const steps = detail.steps.filter((step: any) => step.plan_version === 1);
    for (let i = 0; i < 9; i++) {
      const result = service.runWorkspaceGoal(goal.id, 1);
      if (result.status === 'waiting' || result.status === 'complete') break;
    }
    const finished: any = service.inspectWorkspaceGoal(goal.id);
    const exactWait = finished.steps.some((step: any) => {
      if (step.plan_version !== 1 || step.tool !== 'wait_for_mock_record' || step.status !== 'waiting') return false;
      const value = JSON.parse(step.result_json);
      return value.source === 'outlook' && value.account === account && value.externalId === 'vendor-quote';
    });
    const localTask = finished.personalTasks.length > 0, localDraft = finished.artifacts.length > 0;
    return { ok: factCount === 3 && exactWait && localTask && localDraft && finished.outcomes.length === 0, factCount, stepCount: steps.length, exactWait, localTask, localDraft, externalEffects: finished.outcomes.length, attempts: finished.plannerAttempts.length };
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runThreeFactPlannerSmoke().then(result => { console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; }).catch(() => { console.error('THREE_FACT_SMOKE_FAILED'); process.exitCode = 1; });
}
