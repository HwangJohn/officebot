import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/core.js';
import { fixtures } from '../src/fixtures.js';

if (!process.env.OPENAI_API_KEY) {
  console.error(JSON.stringify({ ok: false, error: 'OPENAI_API_KEY required for manual live smoke only' }));
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'wa-live-'));
let s = createService({ dbPath: join(dir, 'live.sqlite'), engine: 'openai' });
try {
  for (const i of [0, 1, 2, 3, 4, 5]) s.ingest(fixtures[i]);
  await s.advanceGoal('live-smoke');
  const before = s.state();
  const approval = before.approvals.find((a: any) => a.action_type === 'send_message');
  if (!approval || before.sdkSnapshotCount < 1) throw new Error('live_prepare_failed');
  s.close();
  s = createService({ dbPath: join(dir, 'live.sqlite'), engine: 'openai' });
  const first = await s.decide(approval.id, 'approve');
  const second = await s.decide(approval.id, 'approve');
  const state = s.state();
  if (first.status !== 'executed') throw new Error('live_resume_did_not_execute');
  if (second.status !== 'already_executed') throw new Error('duplicate_decision_not_idempotent');
  if (state.outcomes.filter((o: any) => o.action_id === approval.id).length !== 1) throw new Error('duplicate_outcome');
  const key = Buffer.from(process.env.OPENAI_API_KEY);
  const dbFiles = readdirSync(dir).filter(f => f.startsWith('live.sqlite')).map(f => join(dir, f));
  const dbContainsApiKey = dbFiles.some(f => existsSync(f) && readFileSync(f).includes(key));
  if (dbContainsApiKey) throw new Error('db_contains_api_key');
  const responses = state.sdkMeta.flatMap((m: any) => Array.isArray(m.meta?.responses) ? m.meta.responses : []);
  const usage = responses.reduce((acc: any, r: any) => {
    const u = r.usage ?? {};
    acc.requests += 1;
    acc.inputTokens += Number(u.inputTokens ?? u.input_tokens ?? 0);
    acc.outputTokens += Number(u.outputTokens ?? u.output_tokens ?? 0);
    acc.totalTokens += Number(u.totalTokens ?? u.total_tokens ?? 0);
    return acc;
  }, { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  console.log(JSON.stringify({ ok: true, model: 'gpt-5.4-nano', preparedSnapshots: before.sdkSnapshotCount, outcomes: state.outcomes.length, dbContainsApiKey, usage, responseIds: responses.map((r: any) => r.responseId).filter(Boolean), sdkMeta: state.sdkMeta.map((m: any) => ({ approval_id: m.approval_id, meta: m.meta })) }, null, 2));
} catch (e: any) {
  console.error(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  process.exitCode = 1;
} finally {
  try { s.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
