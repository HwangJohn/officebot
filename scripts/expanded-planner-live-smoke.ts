import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createService } from '../src/core.js';
import type { PlannerAdapter } from '../src/workflow.js';

// The default path uses the real model; injection exists only for isolated tests.
// Never open a user DB or call a company/Discord service from this harness.
export async function runExpandedPlannerSmoke(plannerAdapterFactory?: () => PlannerAdapter) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-expanded-planner-'));
  const dbPath = join(dir, 'isolated.sqlite');
  const opts = { dbPath, engine: plannerAdapterFactory ? 'offline' as const : 'openai' as const, plannerAdapterFactory, schedulerClock: () => Date.UTC(2026, 9, 27), handlerTimeoutMs: 55_000, plannerTimeoutMs: 50_000 };
  let service = createService(opts);
  const event = (source: string, project: string, externalId: string, details: unknown, revision = 1) => ({ source, account: 'mock:primary', project, externalId, revision, occurredAt: `2026-10-27T09:00:0${revision}Z`, operation: 'upsert', details });
  const expect = (ok: unknown, code: string) => { if (!ok) throw new Error(code); };
  try {
    service.mockConnectors.ingest(event('teams', 'proposal', 'request', { channel: 'proposal', text: 'Please prepare the proposal; vendor quote is still missing.' }));
    service.mockConnectors.ingest(event('confluence', 'proposal', 'policy', { pageId: 'policy', title: 'Proposal policy', body: 'Draft locally and wait for the vendor quote.' }));
    service.mockConnectors.ingest(event('jira', 'weekly', 'issue', { issueKey: 'ISSUE-7', status: 'blocked', summary: 'ISSUE-7 needs a decision.' }));
    service.mockConnectors.ingest(event('teams', 'weekly', 'decisions', { channel: 'weekly', text: 'DECISION-7: review the blocked issue this week.' }));
    const proposal = service.createWorkspaceGoal({ project: 'proposal', title: 'Prepare proposal review', completion: 'Create a local draft and personal follow-up, then wait for the missing Outlook record with account mock:primary and external ID vendor-quote. After it arrives, draft using the corrected deadline and quote.' });
    const weekly = service.createWorkspaceGoal({ project: 'weekly', title: 'Review weekly issues and decisions', completion: 'Create a local personal follow-up and a weekly draft covering ISSUE-7 and DECISION-7 from the available facts.' });
    await service.planWorkspaceGoal(proposal.id, 0); await service.planWorkspaceGoal(weekly.id, 0);
    const initial: any = service.inspectWorkspaceGoal(proposal.id);
    expect(initial.steps.some((step: any) => step.tool === 'wait_for_mock_record'), 'missing_wait_tool');
    expect(initial.steps.some((step: any) => step.tool === 'personal_followup'), 'missing_proposal_followup');
    for (const goal of [proposal, weekly]) {
      for (let i = 0; i < 9; i++) {
        const result = service.runWorkspaceGoal(goal.id, 1);
        if (result.status === 'waiting' || result.status === 'complete') break;
      }
    }
    let p: any = service.inspectWorkspaceGoal(proposal.id), w: any = service.inspectWorkspaceGoal(weekly.id);
    expect(p.steps.some((step: any) => step.status === 'waiting'), 'proposal_not_waiting');
    expect(p.personalTasks.length > 0, 'missing_proposal_local_followup');
    expect(w.personalTasks.length > 0, 'missing_weekly_local_followup');
    expect(w.artifacts.some((artifact: any) => artifact.content.includes('ISSUE-7') && artifact.content.includes('DECISION-7')), 'weekly_draft_missing_sources');
    service.close(); service = createService(opts);
    expect((service.inspectWorkspaceGoal(proposal.id).steps as any[]).some(step => step.status === 'waiting'), 'waiting_not_restored');
    service.mockConnectors.ingest(event('teams', 'proposal', 'request', { channel: 'proposal', text: 'Correction: use deadline DEADLINE-FRIDAY.' }, 2));
    service.mockConnectors.ingest(event('outlook', 'proposal', 'vendor-quote', { subject: 'Vendor quote', body: 'QUOTE-12 is the approved quote.' }));
    await service.automation.tick();
    p = service.inspectWorkspaceGoal(proposal.id); w = service.inspectWorkspaceGoal(weekly.id);
    expect(p.goal.current_plan > 1 && p.automation.activity.some((item: any) => item.kind === 'goal_replanned'), 'event_replan_failed');
    const current = p.steps.filter((step: any) => step.plan_version === p.goal.current_plan);
    expect(current.every((step: any) => step.status === 'complete'), 'replan_not_complete');
    expect(p.artifacts.some((artifact: any) => artifact.plan_version === p.goal.current_plan && artifact.content.includes('QUOTE-12') && artifact.content.includes('DEADLINE-FRIDAY')), 'updated_draft_missing_sources');
    expect(p.outcomes.length === 0 && w.outcomes.length === 0, 'unexpected_effect');
    return { ok: true, goals: 2, mockSources: 4, waiting: true, correctionAndQuoteReplan: true, restart: true, localFollowups: true, externalEffects: 0 };
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runExpandedPlannerSmoke().then(result => console.log(JSON.stringify(result))).catch(error => {
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'request_failed';
    console.error(`EXPANDED_PLANNER_SMOKE_FAILED:${code}`); process.exitCode = 1;
  });
}
