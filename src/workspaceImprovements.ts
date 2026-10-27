import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { j } from './db.js';
import { sanitizeDiscordText } from './discordChat.js';
import { evaluateImprovement, improvementSha256, type ImprovementEvidence } from './improvementReview.js';

// The legacy fixture and the fixed review-summary target have separate host-owned checks.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = 'src/improvementExample.ts';
const summaryTarget = 'src/reviewSummary.ts';
const summaryHeader = "export function formatReviewSummary(kind: 'daily_review' | 'weekly_review', title: string, blockedReferences: readonly string[]): string {";
const summaryBefore = "  return `${kind === 'daily_review' ? '일간' : '주간'} 점검: ${title}`;";
const summaryAfter = "  return `${kind === 'daily_review' ? '일간' : '주간'} 점검: ${title}${blockedReferences.length ? ` · 차단·지연 ${blockedReferences.length}건 (${blockedReferences.join(', ')})` : ''}`;";
const baselineSummary = [summaryHeader, summaryBefore, '}', ''].join('\n');
const supportedSummary = [summaryHeader, summaryAfter, '}', ''].join('\n');
const summaryPatch = `diff --git a/${summaryTarget} b/${summaryTarget}\n--- a/${summaryTarget}\n+++ b/${summaryTarget}\n@@ -1,3 +1,3 @@\n ${summaryHeader}\n-${summaryBefore}\n+${summaryAfter}\n }\n`;
type ReviewRow = { job_id: string; goal_id: string; kind: string; artifact_json: string; approval_status: string; created_at: number };
type BusinessEvidence = { type: 'review_summary_v1'; reviewId: string; items: ImprovementEvidence[]; snapshot: { kind: string; summary: string; sources: { source: string; reference: string; excerpt: string; blocked: boolean }[] } };
type Snapshot = { id: number; source: string; source_event_id: string; occurred_at: string; project: string; excerpt: string; trusted: number };
type Entry = { id: string; goal_id: string; title: string; rationale: string; patch: string; evidence_json: string; source_hash: string; status: string; review_json: string | null; created_at: string; reviewed_at: string | null };
function exact(value: unknown, keys: string[]): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)); }
function safeText(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && sanitizeDiscordText(value) === value; }

export function createWorkspaceImprovements(db: Db, clock: () => string) {
  function project(goalId: string) {
    const g = db.get<{ project: string }>('SELECT p.project FROM workspace_goals w JOIN workflow_goals g ON g.id=w.goal_id JOIN workflow_goal_projects p ON p.goal_id=g.id WHERE g.id=? AND w.owner=? AND g.owner=?', [goalId, 'local', 'local']);
    if (!g) throw new Error('workspace_goal_not_found');
    return g.project;
  }
  function snapshot(id: number, scope: string) {
    return db.get<Snapshot>('SELECT e.id,ev.source,ev.source_event_id,ev.occurred_at,ev.project,e.excerpt,e.trusted FROM evidence e JOIN events ev ON ev.id=e.event_id WHERE e.id=? AND ev.project=? AND e.trusted=1', [id, scope]);
  }
  function hashSnapshot(row: Snapshot) { return improvementSha256(j.str(row)); }
  function sourceHash(path = target) { return improvementSha256(readFileSync(join(repoRoot, path))); }
  function reviewEvidence(goalId: string, reviewId: string): BusinessEvidence {
    const scope = project(goalId);
    const row = db.get<ReviewRow>('SELECT job_id,goal_id,kind,artifact_json,approval_status,created_at FROM scheduler_reviews WHERE job_id=? AND goal_id=?', [reviewId, goalId]);
    if (!row || !['daily_review', 'weekly_review'].includes(row.kind)) throw new Error('stale_evidence');
    const artifact = j.parse<any>(row.artifact_json, null);
    if (!artifact || typeof artifact.summary !== 'string' || !Array.isArray(artifact.evidence) || !artifact.evidence.length || artifact.evidence.length > 4 || !Array.isArray(artifact.proposals)) throw new Error('stale_evidence');
    const items: ImprovementEvidence[] = [{ id: `review:${row.job_id}`, sha256: improvementSha256(j.str(row)) }];
    const sources: BusinessEvidence['snapshot']['sources'] = [];
    for (const item of artifact.evidence) {
      const match = typeof item?.reference === 'string' ? /^ev-([1-9]\d*):(.+)$/.exec(item.reference) : null;
      if (!match || sources.some(s => s.reference === item.reference)) throw new Error('stale_evidence');
      const evidence = db.get<Snapshot & { details_json: string | null }>('SELECT e.id,e.source,ev.source_event_id,ev.occurred_at,ev.project,e.excerpt,e.trusted,m.details_json FROM evidence e JOIN events ev ON ev.id=e.event_id LEFT JOIN mock_connector_events m ON m.event_id=ev.id WHERE e.id=? AND ev.project=? AND e.trusted=1', [Number(match[1]), scope]);
      if (!evidence || evidence.source_event_id !== match[2] || evidence.source !== item.source || evidence.excerpt !== item.excerpt) throw new Error('stale_evidence');
      const blocked = evidence.source === 'jira' && ['blocked', 'delayed'].includes(String(j.parse<any>(evidence.details_json, {})?.status ?? '').toLowerCase());
      sources.push({ source: evidence.source, reference: item.reference, excerpt: evidence.excerpt, blocked });
      items.push({ id: `review-evidence:${evidence.id}`, sha256: improvementSha256(j.str(evidence)) });
    }
    const blocked = sources.filter(s => s.blocked).map(s => s.reference);
    const refs = artifact.proposals.flatMap((p: any) => Array.isArray(p?.evidenceReferences) ? p.evidenceReferences : []);
    if (!blocked.length || blocked.some(ref => !refs.includes(ref)) || refs.some((ref: unknown) => typeof ref !== 'string' || !blocked.includes(ref))) throw new Error('stale_evidence');
    return { type: 'review_summary_v1', reviewId, items, snapshot: { kind: row.kind, summary: artifact.summary, sources } };
  }
  function validBusiness(goalId: string, value: BusinessEvidence) {
    if (!value || value.type !== 'review_summary_v1' || typeof value.reviewId !== 'string' || j.str(reviewEvidence(goalId, value.reviewId)) !== j.str(value)) throw new Error('stale_evidence');
  }
  function context(goalId: string) {
    const scope = project(goalId);
    const rows = db.all<{ id: number }>('SELECT e.id FROM evidence e JOIN events ev ON ev.id=e.event_id WHERE ev.project=? AND e.trusted=1 ORDER BY ev.occurred_at DESC,e.id DESC LIMIT 20', [scope]);
    return { scope: 'inert_limit_fixture', target, sourceHash: sourceHash(), evidence: rows.map(({ id }) => { const row = snapshot(id, scope)!; return { id: `evidence:${id}`, sha256: hashSnapshot(row), source: row.source, reference: row.source_event_id, occurredAt: row.occurred_at, excerpt: row.excerpt }; }), supportedImprovement: { scope: 'review_summary_v1', target: summaryTarget, sourceHash: sourceHash(summaryTarget) } };
  }
  function validateEvidence(goalId: string, values: ImprovementEvidence[]) {
    const scope = project(goalId);
    if (!Array.isArray(values) || !values.length || values.length > 20 || new Set(values.map(e => e?.id)).size !== values.length) throw new Error('invalid_improvement_evidence');
    for (const item of values) {
      if (!exact(item, ['id', 'sha256']) || typeof item.id !== 'string' || !/^evidence:[1-9]\d*$/.test(item.id) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('invalid_improvement_evidence');
      const current = snapshot(Number(item.id.slice(9)), scope);
      if (!current || hashSnapshot(current) !== item.sha256) throw new Error('stale_evidence');
    }
  }
  function publicEntry(row: Entry) {
    const stored = j.parse<ImprovementEvidence[] | BusinessEvidence>(row.evidence_json, []);
    const business = !Array.isArray(stored) && stored?.type === 'review_summary_v1' ? stored : null;
    const evidence = business ? business.items : stored as ImprovementEvidence[];
    const review = j.parse<any>(row.review_json, null);
    let effectiveStatus = row.status;
    try {
      if (business) validBusiness(row.goal_id, business); else validateEvidence(row.goal_id, evidence);
      if (row.source_hash !== sourceHash(business ? summaryTarget : target) || (review && review.patchSha256 !== improvementSha256(row.patch))) effectiveStatus = 'stale';
    } catch { effectiveStatus = 'stale'; }
    return { id: row.id, goalId: row.goal_id, title: row.title, rationale: row.rationale, patch: row.patch, evidence, evidenceSnapshot: business?.snapshot ?? null, reviewId: business?.reviewId ?? null, scope: business ? 'review_summary_v1' : 'inert_limit_fixture', sourceHash: row.source_hash, status: row.status, effectiveStatus, review, createdAt: row.created_at, reviewedAt: row.reviewed_at };
  }
  function propose(goalId: string) {
    return db.tx(() => {
      project(goalId);
      const rows = db.all<{ job_id: string }>('SELECT job_id FROM scheduler_reviews WHERE goal_id=? ORDER BY created_at DESC,job_id DESC', [goalId]);
      let evidence: BusinessEvidence | undefined;
      for (const row of rows) { try { evidence = reviewEvidence(goalId, row.job_id); break; } catch { /* a stale or healthy review cannot justify this proposal */ } }
      if (!evidence) throw new Error('improvement_no_review_evidence');
      const baseline = readFileSync(join(repoRoot, summaryTarget), 'utf8');
      if (baseline !== baselineSummary) throw new Error('stale_source');
      const id = `improvement-${randomUUID()}`, hash = improvementSha256(baseline);
      db.run('INSERT INTO workspace_improvements(id,goal_id,title,rationale,patch,evidence_json,source_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [id, goalId, '점검 요약에 차단·지연 항목 표시', '저장된 점검에 차단 또는 지연 근거가 있어 요약에서 건수와 출처를 바로 확인하도록 제안합니다.', summaryPatch, j.str(evidence), hash, 'proposed', clock()]);
      validBusiness(goalId, evidence);
      if (sourceHash(summaryTarget) !== hash) throw new Error('stale_source');
      return publicEntry(db.get<Entry>('SELECT * FROM workspace_improvements WHERE id=?', [id])!);
    });
  }
  function list(goalId: string) { project(goalId); return db.all<Entry>('SELECT * FROM workspace_improvements WHERE goal_id=? ORDER BY created_at,id', [goalId]).map(publicEntry); }
  function create(goalId: string, input: unknown) {
    if (!exact(input, ['title', 'rationale', 'patch', 'sourceHash', 'evidence']) || !safeText(input.title, 300) || !safeText(input.rationale, 4000) || !safeText(input.patch, 256_000) || typeof input.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceHash)) throw new Error('invalid_improvement');
    return db.tx(() => {
      validateEvidence(goalId, input.evidence);
      if (input.sourceHash !== sourceHash()) throw new Error('stale_source');
      const id = `improvement-${randomUUID()}`;
      db.run('INSERT INTO workspace_improvements(id,goal_id,title,rationale,patch,evidence_json,source_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [id, goalId, input.title, input.rationale, input.patch, j.str(input.evidence), input.sourceHash, 'proposed', clock()]);
      return publicEntry(db.get<Entry>('SELECT * FROM workspace_improvements WHERE id=?', [id])!);
    });
  }
  function review(goalId: string, id: string) {
    project(goalId);
    const row = db.get<Entry>('SELECT * FROM workspace_improvements WHERE id=? AND goal_id=?', [id, goalId]);
    if (!row) throw new Error('improvement_not_found');
    if (row.status !== 'proposed') return publicEntry(row);
    const stored = j.parse<ImprovementEvidence[] | BusinessEvidence>(row.evidence_json, []);
    const business = !Array.isArray(stored) && stored?.type === 'review_summary_v1' ? stored : null;
    const evidence = business ? business.items : stored as ImprovementEvidence[];
    const selectedTarget = business ? summaryTarget : target;
    if (business) validBusiness(goalId, business); else validateEvidence(goalId, evidence);
    const baseline = readFileSync(join(repoRoot, selectedTarget), 'utf8');
    if (row.source_hash !== improvementSha256(baseline)) throw new Error('stale_source');
    if (business && baseline !== baselineSummary) throw new Error('stale_source');
    const scratch = mkdtempSync(join(tmpdir(), 'work-assistant-improvement-'));
    try {
      const proposal = { title: row.title, rationale: row.rationale, evidence, baseRevision: row.source_hash, baseFiles: { [selectedTarget]: row.source_hash }, sourceScope: [selectedTarget], patch: row.patch };
      // Exact complete-source grammar maps to a single host-interpreted operation. No proposed code is executed.
      const summaryChecks = [
        { id: 'healthy', kind: 'daily_review', title: '정상', refs: [] as string[], expected: '일간 점검: 정상' },
        { id: 'blocked', kind: 'daily_review', title: '출시', refs: ['ev-1:J-1'], expected: '일간 점검: 출시 · 차단·지연 1건 (ev-1:J-1)' },
        { id: 'mixed', kind: 'weekly_review', title: '진행', refs: ['ev-2:J-2', 'ev-3:J-3'], expected: '주간 점검: 진행 · 차단·지연 2건 (ev-2:J-2, ev-3:J-3)' },
        { id: 'no-evidence', kind: 'weekly_review', title: '점검', refs: [] as string[], expected: '주간 점검: 점검' }
      ].map(example => ({ id: `summary-${example.id}`, run(files: Readonly<Record<string, string>>) {
        const understood = files[summaryTarget] === supportedSummary;
        const prefix = `${example.kind === 'daily_review' ? '일간' : '주간'} 점검: ${example.title}`;
        const interpreted = prefix + (example.refs.length ? ` · 차단·지연 ${example.refs.length}건 (${example.refs.join(', ')})` : '');
        return { passed: understood && interpreted === example.expected, detail: understood && interpreted === example.expected ? '완전한 허용 문법과 독립 사례가 일치합니다.' : '허용 문법 또는 기대 결과가 일치하지 않습니다.' };
      } }));
      const evaluated = evaluateImprovement(proposal, {
        workspaceRoot: repoRoot, sourceRoot: repoRoot, artifactRoot: scratch, revision: sourceHash(selectedTarget), allowedFiles: [selectedTarget], evidence,
        checks: business ? summaryChecks : [{ id: 'fixture-limit-regression', run(files) {
          const match = /^\/\/ A restricted, inert fixture for reviewing equivalent limit expressions\.\nexport function capReviewItems\(value: number\) \{\n  return Math\.min\((?:value, (\d+)|(\d+), value)\);\n\}\n$/.exec(files[target]);
          const bound = match ? Number(match[1] ?? match[2]) : NaN;
          return { passed: Number.isFinite(bound) && Math.min(20, bound) === 10 && Math.min(3, bound) === 3, detail: 'The fixture retains its upper bound of 10 and smaller inputs.' };
        } }]
      });
      let reviewedFile: string | null = null;
      if (evaluated.status !== 'rejected') reviewedFile = readFileSync(join(evaluated.artifactDir, 'evaluation', ...selectedTarget.split('/')), 'utf8');
      const refs = business?.snapshot.sources.filter(s => s.blocked).map(s => s.reference) ?? [];
      const before = business?.snapshot.summary ?? null;
      const after = evaluated.status === 'review_required' && before ? `${before} · 차단·지연 ${refs.length}건 (${refs.join(', ')})` : null;
      const bundle = { scope: business ? 'review_summary_v1' : 'inert_limit_fixture', target: selectedTarget, baseFile: baseline, patchSha256: evaluated.patchSha256, status: evaluated.status, reason: evaluated.reason ?? null, checks: evaluated.checks, reviewedFile, example: business ? { before, after } : null, finalApplication: evaluated.finalApplication };
      return db.tx(() => {
        if (business) validBusiness(goalId, business); else validateEvidence(goalId, evidence);
        if (row.source_hash !== sourceHash(selectedTarget)) throw new Error('stale_source');
        const current = db.get<Entry>('SELECT * FROM workspace_improvements WHERE id=? AND goal_id=?', [id, goalId]);
        if (!current || current.status !== 'proposed' || current.patch !== row.patch || current.evidence_json !== row.evidence_json || current.source_hash !== row.source_hash) throw new Error('stale_improvement');
        db.run('UPDATE workspace_improvements SET status=?,review_json=?,reviewed_at=? WHERE id=? AND status=?', [evaluated.status, j.str(bundle), clock(), id, 'proposed']);
        return publicEntry(db.get<Entry>('SELECT * FROM workspace_improvements WHERE id=?', [id])!);
      });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  return { context, create, list, propose, review };
}
