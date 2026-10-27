import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createService } from '../src/core.js';
import { fixtures } from '../src/fixtures.js';

function fail(error: string) {
  console.error(JSON.stringify({ ok: false, error }));
  process.exitCode = 1;
}

if (!process.env.OPENAI_API_KEY) {
  fail('OPENAI_API_KEY required for manual live analysis smoke only');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'wa-analysis-live-'));
const dbPath = join(dir, 'analysis-live.sqlite');
let s = createService({ dbPath, engine: 'openai' });

try {
  for (const i of [0, 1, 2, 3]) s.ingest(fixtures[i]);
  const before = s.state();
  const first = await s.analyzeGoal('목요일 또는 금요일 기한과 견적 대기 상태를 근거로 한국어 제안서 초안을 제안해줘');
  if (first.output.status !== 'success') throw new Error('analysis_not_success');
  if (!first.output.koreanSummary || !first.output.draftProposal.body) throw new Error('analysis_empty_output');
  const cited = new Set<string>([
    ...first.output.summaryEvidenceIds,
    ...first.output.observations.flatMap((o: any) => o.evidenceIds),
    ...first.output.suggestedNextSteps.flatMap((st: any) => st.evidenceIds),
    ...first.output.draftProposal.evidenceIds
  ]);
  if (cited.size < 1) throw new Error('analysis_missing_citations');
  const cached = await s.analyzeGoal('목요일 또는 금요일 기한과 견적 대기 상태를 근거로 한국어 제안서 초안을 제안해줘');
  if (cached.source !== 'cached' || cached.id !== first.id) throw new Error('analysis_cache_miss');
  s.close();

  s = createService({ dbPath, engine: 'openai' });
  const reopened = s.state();
  if (!reopened.latestAnalysis || reopened.latestAnalysis.id !== first.id) throw new Error('analysis_not_persistent');
  s.ingest(fixtures[4]);
  if (!s.state().latestAnalysis.stale) throw new Error('analysis_not_stale_after_due_change');
  const second = await s.analyzeGoal('정정된 목요일 기한을 반영해서 다시 제안해줘');
  if (second.id === first.id || second.output.status !== 'success') throw new Error('analysis_reanalysis_failed');
  const after = s.state();
  if (after.approvals.length !== before.approvals.length || after.outcomes.length !== before.outcomes.length) throw new Error('analysis_created_business_side_effect');

  const key = Buffer.from(process.env.OPENAI_API_KEY);
  const safeDir = resolve(dir);
  const dbFiles = readdirSync(dir).filter(f => f.startsWith('analysis-live.sqlite')).map(f => resolve(dir, f));
  if (dbFiles.some(f => !f.startsWith(safeDir))) throw new Error('temp_dir_escape');
  const dbContainsApiKey = dbFiles.some(f => existsSync(f) && readFileSync(f).includes(key));
  if (dbContainsApiKey) throw new Error('db_contains_api_key');
  const records = s.db.all<any>('SELECT meta_json FROM analysis_records ORDER BY id');
  const responses = records.flatMap((r: any) => {
    try {
      const meta = JSON.parse(r.meta_json || '{}');
      return Array.isArray(meta.responses) ? meta.responses : [];
    } catch {
      return [];
    }
  });
  const usage = responses.reduce((acc: any, r: any) => {
    const u = r.usage ?? {};
    acc.requests += 1;
    acc.inputTokens += Number(u.inputTokens ?? u.input_tokens ?? 0);
    acc.outputTokens += Number(u.outputTokens ?? u.output_tokens ?? 0);
    acc.totalTokens += Number(u.totalTokens ?? u.total_tokens ?? 0);
    return acc;
  }, { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  console.log(JSON.stringify({
    ok: true,
    model: 'gpt-5.4-nano',
    analyses: records.length,
    sources: [first.source, cached.source, second.source],
    staleAfterCorrection: true,
    approvals: after.approvals.length,
    outcomes: after.outcomes.length,
    dbContainsApiKey,
    usage,
    responseIds: responses.map((r: any) => r.responseId).filter(Boolean).slice(0, 4)
  }, null, 2));
} catch {
  fail('analysis live smoke failed');
} finally {
  try { s.close(); } catch {}
  const safeDir = resolve(dir);
  if (safeDir.startsWith(resolve(tmpdir()))) rmSync(safeDir, { recursive: true, force: true });
}
