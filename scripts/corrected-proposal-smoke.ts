import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createService } from '../src/core.js';
import { PlannerAttemptFailure } from '../src/plannerDiagnostics.js';
import { createOpenAIPlannerAdapter } from '../src/modelPlanner.js';
import { requireOpenAIKey } from '../src/openaiAdapter.js';
import { sanitizeDiscordText } from '../src/discordChat.js';
import type { PlannerAdapter } from '../src/workflow.js';

// A fake seed plan followed by exactly one model plan, isolated synthetic records only.
type SmokeEvidence = { scope: string; finalDraft: string; tasks: { taskKey: string; title: string; status: string }[]; signals: { instruction: boolean; missing: boolean; untilArrival: boolean } };
export async function runCorrectedProposalSmoke(factory?: () => PlannerAdapter, onEvidence?: (evidence: SmokeEvidence) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-corrected-smoke-')); let initial = true;
  const seed: PlannerAdapter = async ctx => ({ steps: [
    { id: 'fact', tool: 'record_fact', dependsOn: [], input: ctx.facts[0] },
    { id: 'task', tool: 'personal_followup', dependsOn: ['fact'], input: { taskKey: 'review-draft', title: 'Review local proposal', factStepId: 'fact' } }
  ] });
  let actual: PlannerAdapter | undefined;
  const svc = createService({ dbPath: join(dir, 'isolated.sqlite'), engine: factory ? 'offline' : 'openai', plannerAdapterFactory: () => async ctx => initial ? seed(ctx) : (actual ??= factory ? factory() : createOpenAIPlannerAdapter())(ctx), plannerTimeoutMs: 50_000 });
  try {
    const project = 'SYNTHETIC-corrected-proposal', account = 'mock:acceptance';
    const ingest = (source: string, externalId: string, revision: number, occurredAt: string, details: unknown) => svc.mockConnectors.ingest({ source, account, project, externalId, revision, occurredAt, operation: 'upsert', details });
    ingest('teams', 'request', 1, '2026-10-27T09:00:00Z', { channel: 'synthetic', text: 'SYNTHETIC: prepare local draft; quote is missing.' });
    ingest('confluence', 'policy', 1, '2026-10-27T09:00:00Z', { pageId: 'synthetic-policy', title: 'SYNTHETIC proposal policy', body: 'Draft locally and wait for the vendor quote.' });
    ingest('outlook', 'planning-note', 1, '2026-10-27T09:00:00Z', { subject: 'SYNTHETIC planning note', body: 'The vendor quote is not yet available.' });
    const goal = svc.createWorkspaceGoal({ project, title: 'SYNTHETIC proposal review', completion: 'Create a local proposal draft and personal follow-up, then wait for Outlook account mock:acceptance external ID vendor-quote. After it arrives use the corrected deadline and quote. Never send or change shared systems.' });
    await svc.planWorkspaceGoal(goal.id, 0);
    svc.runWorkspaceGoal(goal.id, 1); svc.runWorkspaceGoal(goal.id, 1);
    ingest('teams', 'request', 2, '2026-10-27T10:00:00Z', { channel: 'synthetic', text: 'SYNTHETIC correction: proposal deadline is DEADLINE-FRIDAY. Use the exact vendor quote when available.' });
    const quote = ingest('outlook', 'vendor-quote', 1, '2026-10-27T10:01:00Z', { subject: 'SYNTHETIC quote', body: 'SYNTHETIC QUOTE12: vendor quote is 12 units. Corrected deadline is DEADLINE-FRIDAY.' });
    initial = false;
    try { await svc.planWorkspaceGoal(goal.id, 1); } catch (error) { return { ok: false, code: error instanceof PlannerAttemptFailure ? error.code : 'planner_unknown_failure', modelCalls: 1 }; }
    for (let i = 0; i < 9; i++) { const r = svc.runWorkspaceGoal(goal.id, 2); if (r.status === 'waiting' || r.status === 'complete') break; }
    const detail: any = svc.inspectWorkspaceGoal(goal.id);
    const latest = detail.artifacts.filter((a: any) => a.plan_version === 2).at(-1);
    const text = String(latest?.content ?? '');
    const hasAmount = /\b12\b/.test(text), hasDeadline = text.includes('DEADLINE-FRIDAY');
    const signals = { instruction: /\b(?:replace|insert|add|update)\b.{0,80}\b(?:quote|amount|value)\b/i.test(text), missing: /\b(?:quote|amount)\b.{0,60}\b(?:placeholder|pending|missing|unavailable|not (?:yet )?(?:available|received|arrived))\b/i.test(text), untilArrival: /\buntil\b.{0,60}\b(?:quote|record)\b.{0,30}\b(?:arrives|available|received)\b/i.test(text) };
    const futurePlaceholder = signals.instruction || signals.missing || signals.untilArrival;
    const quoteSource = svc.db.get<{ source_event_id: string }>('SELECT source_event_id FROM events WHERE id=?', [quote.eventId]);
    const sourceLinked = Boolean(latest && quoteSource && detail.facts.some((f: any) => f.id === latest.source_fact_id && f.plan_version === 2 && f.source === `outlook:${quoteSource.source_event_id}`));
    const openTasks = detail.personalTasks.filter((t: any) => t.status === 'open').length;
    const noSharedEffects = detail.outcomes.length === 0;
    if (onEvidence) {
      // Only synthetic model output is recorded; redact the runtime model key and token patterns before truncation.
      const knownSecrets = factory ? [] : [requireOpenAIKey()];
      const clean = (value: unknown, limit: number) => sanitizeDiscordText(String(value ?? ''), knownSecrets).slice(0, limit);
      onEvidence({ scope: 'synthetic isolated model output only', finalDraft: clean(text, 2000), tasks: detail.personalTasks.slice(0, 20).map((t: any) => ({ taskKey: clean(t.task_key, 100), title: clean(t.title, 300), status: clean(t.status, 20) })), signals });
    }
    return { ok: hasAmount && hasDeadline && sourceLinked && noSharedEffects && !futurePlaceholder && openTasks === 1, hasAmount, hasDeadline, futurePlaceholder, sourceLinked, openTasks, noSharedEffects, modelCalls: 1 };
  } finally { svc.close(); rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCorrectedProposalSmoke().then(result => { console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; }).catch(() => { console.error('CORRECTED_PROPOSAL_SMOKE_FAILED'); process.exitCode = 1; });
}
