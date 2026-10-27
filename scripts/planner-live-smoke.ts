import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildServer } from '../src/server.js';
import type { PlannerAdapter } from '../src/workflow.js';

// Default is a real model call. An injected adapter is reserved for isolated tests.
export async function runPlannerSmoke(plannerAdapterFactory?: () => PlannerAdapter) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-planner-live-'));
  const dbPath = join(dir, 'isolated.sqlite');
  const opts = { dbPath, engine: plannerAdapterFactory ? 'offline' as const : 'openai' as const, plannerAdapterFactory, schedulerClock: () => Date.UTC(2026, 9, 27) };
  let app: ReturnType<typeof buildServer> | undefined;
  try {
    app = buildServer(opts);
    const post = async (url: string, payload: Record<string, unknown> = {}) => {
      const response = await app!.inject({ method: 'POST', url, payload });
      if (response.statusCode !== 200) throw new Error('smoke_request_failed');
      return response.json();
    };
    const record = (project: string, text: string, revision = 1) => ({ source: 'teams', account: 'mock:primary', project, externalId: 'synthetic-1', revision, occurredAt: '2026-10-27T00:00:00Z', operation: 'upsert', details: { channel: project, text } });
    await post('/api/mock-events', record('synthetic-alpha', 'The proposal draft needs a security review.'));
    await post('/api/mock-events', record('synthetic-beta', 'The weekly handoff is waiting for a deployment date.'));
    const alpha = await post('/api/goals', { project: 'synthetic-alpha', title: 'Prepare a proposal review draft', completion: 'A local review draft with source' });
    const beta = await post('/api/goals', { project: 'synthetic-beta', title: 'Prepare a weekly handoff draft', completion: 'A local review draft with source' });
    for (const goal of [alpha, beta]) {
      const plan = await post(`/api/goals/${goal.id}/plan`, { expectedVersion: 0 });
      if (plan.version !== 1 || plan.workflow.steps.length > 8) throw new Error('invalid_smoke_plan');
      for (let i = 0; i < plan.workflow.steps.length; i++) await post(`/api/goals/${goal.id}/step`, { version: 1 });
      const detail = (await app.inject(`/api/goals/${goal.id}`)).json();
      if (!detail.artifacts.length || detail.outcomes.length) throw new Error('invalid_smoke_execution');
    }
    await post('/api/mock-events', record('synthetic-alpha', 'The security review is complete; the draft needs final review.', 2));
    await post('/api/scheduler/tick');
    const updated = (await app.inject(`/api/goals/${alpha.id}`)).json();
    if (updated.goal.current_plan !== 2 || !updated.automation.activity.some((a: any) => a.kind === 'goal_replanned')) throw new Error('event_replan_failed');
    await app.close(); app = buildServer(opts);
    const restored = (await app.inject(`/api/goals/${alpha.id}`)).json();
    if (restored.goal.current_plan !== 2 || !restored.artifacts.length) throw new Error('restart_failed');
    return { ok: true, goals: 2, eventReplanned: true, restart: true, externalEffects: 0 };
  } finally {
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPlannerSmoke().then(result => console.log(JSON.stringify(result))).catch(() => { console.error('PLANNER_LIVE_SMOKE_FAILED'); process.exitCode = 1; });
}
