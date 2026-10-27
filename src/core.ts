import crypto from 'node:crypto';
import { Db, j } from './db.js';
import { FIXED_NOW, fixtures, PROPOSAL, snapshots, type FixtureEvent } from './fixtures.js';
import { createAgentsLiveAdapter, type LiveAdapter } from './openaiAdapter.js';
import { createOfflineAnalystAdapter, createOpenAIAnalystAdapter, needsEvidenceOutput, normalizeGoal, stableHash, validateAnalysisOutput, type AnalysisContext, type AnalystAdapter } from './analysis.js';
import { createWorkflow, type PlannerAdapter } from './workflow.js';
import { PlannerAttemptFailure } from './plannerDiagnostics.js';
import { createOpenAIPlannerAdapter } from './modelPlanner.js';
import { createMemory } from './memory.js';
import { createMockConnectors } from './mockConnectors.js';
import { createWorkspaceApprovals } from './workspaceApprovals.js';
import { createDurableScheduler, type HandlerContext } from './durableScheduler.js';
import { createWorkspaceAutomation } from './workspaceAutomation.js';
import { createWorkspaceImprovements } from './workspaceImprovements.js';
import { createDiscordNotifications } from './discordNotifications.js';
import { DISCORD_BUSINESS_SCOPE, hasDiscordScope } from './discordScope.js';

export type Engine = 'offline' | 'openai';
export type Decision = 'approve' | 'reject' | 'defer' | 'expire' | 'edit';
export type DecideResult = { status: string; newApprovalId?: string; approvals?: string[]; reason?: string };
export type LiveAdapterFactory = (opts: { commitApprovedAction: (id: string) => unknown; getApproval: (id: string) => any }) => LiveAdapter;
export type AnalystAdapterFactory = () => AnalystAdapter;
export type Service = ReturnType<typeof createService>;
type ActionType = 'send_message' | 'jira_update';

function hash(v: unknown) { return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
function addDays(iso: string, days: number) { const d = new Date(iso); d.setUTCDate(d.getUTCDate() + days); return d.toISOString(); }
function publicApproval(a: any) { return { ...a, payload: j.parse(a.payload_json, {}), payload_json: undefined, payload_hash: undefined }; }

export function createService(opts: { dbPath: string; clock?: string; engine?: Engine; liveAdapterFactory?: LiveAdapterFactory; analystAdapterFactory?: AnalystAdapterFactory; plannerAdapterFactory?: () => PlannerAdapter; plannerTimeoutMs?: number; handlerTimeoutMs?: number; discordOwnerId?: string; schedulerClock?: () => number }) {
  const db = new Db(opts.dbPath);
  const engine = opts.engine ?? 'offline';
  let now = opts.clock ?? getKv('clock', FIXED_NOW);
  const workflow = createWorkflow(db, () => now);
  const memory = createMemory(db, () => now);
  const schedulerClock = opts.schedulerClock ?? Date.now;
  const scheduler = createDurableScheduler(db, { now: schedulerClock, maxPerTick: 10, maxStartsPerGoalPerUtcDay: 30 });
  const automation = createWorkspaceAutomation(db, scheduler, schedulerClock, { continueGoal: continueWorkspaceGoal, handlerTimeoutMs: opts.handlerTimeoutMs });
  const mockConnectors = createMockConnectors(db, () => now, automation.enqueueEvent);
  const notifications = createDiscordNotifications(db, schedulerClock, hasDiscordScope() && opts.discordOwnerId === DISCORD_BUSINESS_SCOPE.ownerId, (goalId, approvalId) => workspaceApprovals.isNotificationEligible(goalId, approvalId));
  const workspaceApprovals = createWorkspaceApprovals(db, () => now, workflow, mockConnectors, opts.discordOwnerId, notifications.enqueueApproval);
  const workspaceImprovements = createWorkspaceImprovements(db, () => now);
  let live: LiveAdapter | undefined;
  let analyst: AnalystAdapter | undefined;
  let planner: PlannerAdapter | undefined;
  const inFlightAnalysis = new Map<string, Promise<any>>();
  const inFlightDiscordPlans = new Map<string, { signature: string; promise: Promise<any> }>();
  setKv('clock', now);
  if (!getKv('jira', '')) setKv('jira', j.str(snapshots.jira));
  ensureGoal();
  if (engine === 'openai') live = opts.liveAdapterFactory ? opts.liveAdapterFactory({ commitApprovedAction, getApproval: privateApproval }) : createAgentsLiveAdapter({ commitApprovedAction, getApproval: privateApproval });
  analyst = opts.analystAdapterFactory ? opts.analystAdapterFactory() : (engine === 'openai' && !opts.liveAdapterFactory ? createOpenAIAnalystAdapter() : createOfflineAnalystAdapter());

  function getKv(key: string, fallback: string) { return db.get<{ value: string }>('SELECT value FROM kv WHERE key=?', [key])?.value ?? fallback; }
  function setKv(key: string, value: string) { db.run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]); }
  function goal() { return db.get<any>('SELECT * FROM goals WHERE id=?', ['proposal'])!; }
  function jira() { return j.parse<any>(getKv('jira', j.str(snapshots.jira)), snapshots.jira); }
  function ensureGoal() {
    db.run(`INSERT OR IGNORE INTO goals(id,project,due_date,quote,status,next_step,wait_condition,next_check_at,task_version,updated_at)
      VALUES('proposal',?,'',NULL,'대기','이벤트 수집','요청 대기',?,0,?)`, [PROPOSAL, now, now]);
  }
  function bump(fields: Record<string, unknown>) {
    const g = goal(); const nv = Number(g.task_version) + 1;
    db.run(`UPDATE goals SET ${Object.keys(fields).map(k => `${k}=?`).join(',')}, task_version=?, updated_at=? WHERE id='proposal'`, [...Object.values(fields) as any[], nv, now]);
    db.run(`UPDATE approvals SET status='stale', decision_note='업무 버전 변경으로 승인 무효', decided_at=? WHERE status IN ('pending','deferred') AND task_version < ?`, [now, nv]);
  }
  function evidence(eventId: number, ev: FixtureEvent) {
    db.run('INSERT INTO evidence(event_id,source,title,excerpt,trusted,created_at) VALUES(?,?,?,?,?,?)', [eventId, ev.source, ev.title, ev.body.slice(0, 240), ev.kind === 'hostile_instruction' ? 0 : 1, now]);
  }

  function ingest(ev: FixtureEvent | undefined) {
    if (!ev) throw new Error('invalid_fixture_index');
    return db.tx(() => {
      const r = db.run('INSERT OR IGNORE INTO events(source,source_event_id,occurred_at,project,kind,title,body,raw_json,processed_at) VALUES(?,?,?,?,?,?,?,?,?)', [ev.source, ev.sourceEventId, ev.occurredAt, ev.project, ev.kind, ev.title, ev.body, j.str(ev), now]);
      if (r.changes === 0) { db.run('INSERT INTO duplicate_attempts(source_event_id,attempted_at) VALUES(?,?)', [ev.sourceEventId, now]); return { inserted: false, reason: 'duplicate' }; }
      const id = Number(db.get<{ id: number }>('SELECT id FROM events WHERE source_event_id=?', [ev.sourceEventId])!.id);
      evidence(id, ev);
      if (ev.kind !== 'hostile_instruction') automation.enqueueEvent(ev.project, id);
      if (ev.project !== PROPOSAL) return { inserted: true, ignored: true };
      if (ev.kind === 'request') {
        bump({ due_date: String(ev.data?.dueDate ?? '2026-10-30'), status: '진행', next_step: '정책과 Jira 확인', wait_condition: '' });
        upsertTodo('proposal-followup', '제안서 보완 및 회신 준비', String(ev.data?.dueDate ?? '2026-10-30'));
      } else if (ev.kind === 'due_correction') {
        bump({ due_date: String(ev.data?.dueDate ?? '2026-10-29'), status: '진행', next_step: '정정된 기한으로 초안 갱신', wait_condition: '' });
        upsertTodo('proposal-followup', '제안서 보완 및 회신 준비', String(ev.data?.dueDate ?? '2026-10-29'));
      } else if (ev.kind === 'quote_wait') {
        db.run("UPDATE goals SET status='회신 대기', wait_condition='견적 회신 대기', next_step='견적 도착 시 초안 갱신', updated_at=? WHERE id='proposal'", [now]);
      } else if (ev.kind === 'quote_received') {
        bump({ quote: String(ev.data?.quote ?? '12% discount'), status: '진행', wait_condition: '', next_step: '최종 초안과 승인 카드 준비' });
      }
      return { inserted: true };
    });
  }
  function upsertTodo(id: string, title: string, due: string) {
    const v = goal().task_version;
    db.run(`INSERT INTO todos(id,title,due_date,status,scope,task_version,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,due_date=excluded.due_date,status=excluded.status,task_version=excluded.task_version,updated_at=excluded.updated_at`, [id, title, due, '자동 갱신됨', 'personal-local', v, now]);
  }
  function draftContent(g = goal()) {
    return `제안서 회신 초안\n- 기한: ${g.due_date || '미정'}\n- 정책: ${snapshots.confluence.excerpt}\n- Jira: PROJ-17 ${jira().status} v${jira().version}\n- 견적: ${g.quote ?? '벤더 견적 대기'}\n- 외부 발송과 공유 Jira 변경은 승인 후 모의 실행`;
  }
  function analysisEvidence() {
    return db.all<any>(`SELECT * FROM (
        SELECT e.id,e.source,e.title,e.excerpt,e.trusted,e.created_at,ev.source_event_id,ev.occurred_at,ev.kind
        FROM evidence e JOIN events ev ON ev.id=e.event_id
        WHERE ev.project=? AND e.trusted=1
        ORDER BY ev.occurred_at DESC,e.id DESC LIMIT 12
      ) ORDER BY occurred_at,id`, [PROPOSAL]).map((r:any) => ({
        id: `ev-${r.id}`,
        sourceEventId: String(r.source_event_id),
        source: String(r.source),
        kind: String(r.kind),
        occurredAt: String(r.occurred_at),
        title: String(r.title).slice(0, 160),
        excerpt: String(r.excerpt).slice(0, 360)
      }));
  }
  function analysisEvidenceRevision() {
    const rows = db.all<any>(`SELECT e.id,ev.source_event_id,ev.occurred_at,ev.kind,e.source,e.title,e.excerpt
      FROM evidence e JOIN events ev ON ev.id=e.event_id
      WHERE ev.project=? AND e.trusted=1
      ORDER BY e.id`, [PROPOSAL]);
    return stableHash(rows.map((r:any) => ({
      id: Number(r.id),
      sourceEventId: String(r.source_event_id),
      occurredAt: String(r.occurred_at),
      kind: String(r.kind),
      source: String(r.source),
      title: String(r.title),
      excerpt: String(r.excerpt)
    })));
  }
  function analysisContext(query = ''): AnalysisContext {
    const g = goal(); const jj = jira();
    return {
      project: PROPOSAL,
      now,
      goal: {
        dueDate: String(g.due_date ?? ''),
        quote: String(g.quote ?? ''),
        status: String(g.status ?? ''),
        nextStep: String(g.next_step ?? ''),
        waitCondition: String(g.wait_condition ?? ''),
        taskVersion: Number(g.task_version ?? 0),
        updatedAt: String(g.updated_at ?? '')
      },
      jira: {
        key: String(jj.key ?? 'PROJ-17'),
        version: Number(jj.version ?? 0),
        status: String(jj.status ?? ''),
        summary: String(jj.summary ?? ''),
        assignee: String(jj.assignee ?? '')
      },
      evidence: analysisEvidence(),
      evidenceRevision: analysisEvidenceRevision(),
      memory: memory.retrieve(PROPOSAL, 'local', query)
    };
  }
  function analysisContextHash(ctx = analysisContext()) {
    return stableHash(ctx);
  }
  function publicAnalysis(row: any | undefined, currentHash = analysisContextHash()) {
    if (!row) return undefined;
    const output = j.parse(row.output_json, undefined);
    const context = j.parse<any>(row.context_json, {});
    const evidenceSources = Array.isArray(context.evidence) ? context.evidence.map((e:any) => ({
      id: String(e.id ?? ''),
      source: String(e.source ?? ''),
      sourceEventId: String(e.sourceEventId ?? ''),
      occurredAt: String(e.occurredAt ?? ''),
      title: String(e.title ?? '').slice(0, 160),
      excerpt: String(e.excerpt ?? '').slice(0, 360)
    })).filter((e:any) => e.id) : [];
    return {
      id: row.id,
      normalizedGoal: row.normalized_goal,
      engine: row.engine,
      status: row.status,
      taskVersion: Number(row.task_version),
      createdAt: row.created_at,
      stale: row.context_hash !== currentHash,
      output,
      evidenceSources,
      memorySources: context.memory ?? { preferences: [], conversation: [] },
      meta: j.parse(row.meta_json, {})
    };
  }
  function latestAnalysis() {
    const row = db.get<any>('SELECT * FROM analysis_records ORDER BY id DESC LIMIT 1');
    return row ? publicAnalysis(row, analysisContextHash(analysisContext(row.normalized_goal))) : undefined;
  }
  async function analyzeGoal(goalText: unknown) {
    if (typeof goalText !== 'string') throw new Error('bad_goal');
    if (goalText.length > 1000) throw new Error('bad_goal');
    const normalized = normalizeGoal(goalText);
    if (!normalized || normalized.length > 1000) throw new Error('bad_goal');
    const ctx = analysisContext(normalized);
    const contextHash = analysisContextHash(ctx);
    const adapter = analyst!;
    const analysisEngine = adapter.engine;
    const cache = db.get<any>('SELECT * FROM analysis_records WHERE normalized_goal=? AND engine=? AND context_hash=?', [normalized, analysisEngine, contextHash]);
    if (cache) return { ...publicAnalysis(cache, contextHash), source: 'cached' };
    const key = `${analysisEngine}:${stableHash({ normalized, contextHash })}`;
    const existing = inFlightAnalysis.get(key);
    if (existing) return existing;
    const promise = (async () => {
      if (ctx.evidence.length === 0) {
        const output = needsEvidenceOutput();
        const inputFingerprint = stableHash({ normalized, contextHash, engine: analysisEngine });
        db.run('INSERT OR IGNORE INTO analysis_records(normalized_goal,engine,context_hash,input_fingerprint,task_version,context_json,output_json,meta_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [normalized, analysisEngine, contextHash, inputFingerprint, ctx.goal.taskVersion, j.str({ sourceIds: [], evidenceIds: [], evidence: [], evidenceRevision: ctx.evidenceRevision, memory: ctx.memory, goal: ctx.goal, jira: ctx.jira, now: ctx.now }), j.str(output), j.str({ deterministic: true, noEvidence: true }), output.status, now]);
        const row = db.get<any>('SELECT * FROM analysis_records WHERE normalized_goal=? AND engine=? AND context_hash=?', [normalized, analysisEngine, contextHash]);
        return { ...publicAnalysis(row, contextHash), source: analysisEngine === 'offline-mock' ? 'offline' : 'live' };
      }
      let result;
      try {
        result = await adapter.analyze(normalized, ctx);
      } catch {
        throw new Error('analysis_failed');
      }
      if (analysisContextHash(analysisContext(normalized)) !== contextHash) throw new Error('analysis_context_changed');
      const output = validateAnalysisOutput(result.output, new Set(ctx.evidence.map((e) => e.id)));
      const inputFingerprint = stableHash({ normalized, contextHash, engine: analysisEngine });
      db.run('INSERT OR IGNORE INTO analysis_records(normalized_goal,engine,context_hash,input_fingerprint,task_version,context_json,output_json,meta_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [normalized, analysisEngine, contextHash, inputFingerprint, ctx.goal.taskVersion, j.str({ sourceIds: ctx.evidence.map((e) => e.sourceEventId), evidenceIds: ctx.evidence.map((e) => e.id), evidence: ctx.evidence, evidenceRevision: ctx.evidenceRevision, memory: ctx.memory, goal: ctx.goal, jira: ctx.jira, now: ctx.now }), j.str(output), j.str(boundMeta(result.meta ?? {})), output.status, now]);
      const row = db.get<any>('SELECT * FROM analysis_records WHERE normalized_goal=? AND engine=? AND context_hash=?', [normalized, analysisEngine, contextHash]);
      return { ...publicAnalysis(row, contextHash), source: analysisEngine === 'offline-mock' ? 'offline' : 'live' };
    })().finally(() => inFlightAnalysis.delete(key));
    inFlightAnalysis.set(key, promise);
    return promise;
  }
  function boundMeta(meta: Record<string, unknown>) {
    return j.parse(j.str(meta).slice(0, 3000), { truncated: true });
  }
  function saveDraft() {
    const g = goal();
    if (!db.get<any>('SELECT id FROM artifacts WHERE goal_id=? AND kind=? AND version=?', ['proposal', 'draft', g.task_version])) {
      const refs = { confluence: snapshots.confluence.id, jira: jira().key };
      const content = runLocalArtifact({ goalId: 'legacy:proposal', title: 'Proposal', completion: 'Draft', kind: 'draft', source: 'local:proposal-state', fact: j.str({ taskVersion: g.task_version, dueDate: g.due_date, quote: g.quote, refs, jiraVersion: jira().version }), content: draftContent(g) });
      db.run('INSERT INTO artifacts(goal_id,kind,version,content,evidence_json,created_at) VALUES(?,?,?,?,?,?)', ['proposal', 'draft', g.task_version, content, j.str(refs), now]);
    }
  }
  // Domain adapters supply snapshots and content; the executor knows no goal-specific rules.
  // Callers wrap this and their legacy projection in one transaction.
  function runLocalArtifact(input: { goalId: string; title: string; completion: string; kind: string; source: string; fact: string; content: string }) {
    let current = workflow.inspect(input.goalId).goal as { current_plan: number } | undefined;
    if (!current) {
      workflow.createGoal({ id: input.goalId, title: input.title, owner: 'user', completion: input.completion });
      current = { current_plan: 0 };
    }
    const version = workflow.savePlan(input.goalId, current.current_plan, [
      { id: 'snapshot', tool: 'record_fact', dependsOn: [], input: { key: 'snapshot', value: input.fact, source: input.source, observedAt: now } },
      { id: 'artifact', tool: 'create_artifact', dependsOn: ['snapshot'], input: { kind: input.kind, content: input.content, factStepId: 'snapshot' } }
    ]);
    workflow.runNext(input.goalId, version);
    const result = workflow.runNext(input.goalId, version);
    const artifact = db.get<{ content: string }>('SELECT content FROM workflow_artifacts WHERE id=? AND goal_id=? AND plan_version=?', [result.result!.id, input.goalId, version]);
    if (!artifact) throw new Error('workflow_artifact_missing');
    return artifact.content;
  }
  function canonicalPayload(type: ActionType, g = goal()) {
    if (type === 'send_message') return { recipient: 'person1@example.com', channel: 'outlook', subject: '[목업] 제안서 보완 회신', body: draftContent(g), dueDate: g.due_date, quote: g.quote };
    return { target: 'PROJ-17', fromVersion: jira().version, setStatus: '고객 회신 준비 완료', comment: `제안서 초안 준비. 기한 ${g.due_date}, 견적 ${g.quote}` };
  }
  function activeOrExecuted(type: ActionType, v: number) {
    return db.get<any>(`SELECT * FROM approvals WHERE action_type=? AND task_version=? AND status IN ('pending','deferred','processing','uncertain','executed') ORDER BY reissue DESC LIMIT 1`, [type, v]);
  }
  function nextReissue(type: ActionType, v: number) {
    return (db.get<{ n: number }>('SELECT COALESCE(MAX(reissue),0)+1 n FROM approvals WHERE action_type=? AND task_version=?', [type, v])?.n ?? 1);
  }
  function createApproval(type: ActionType) {
    const g = goal(); const v = Number(g.task_version);
    const target = type === 'send_message' ? 'person1@example.com' : 'PROJ-17';
    // An interrupted or uncertain write must be reconciled before any later version can repeat it.
    const unresolved = db.get<any>("SELECT id FROM approvals WHERE action_type=? AND target=? AND status IN ('processing','uncertain') ORDER BY created_at LIMIT 1", [type, target]);
    if (unresolved) return unresolved.id as string;
    const existing = activeOrExecuted(type, v); if (existing) return existing.id as string;
    const reissue = nextReissue(type, v); const p = canonicalPayload(type, g); const id = `${type}-v${v}-r${reissue}`;
    db.run(`INSERT INTO approvals(id,action_type,target,payload_json,payload_hash,task_version,target_version,status,expires_at,created_at,reissue)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [id, type, type === 'send_message' ? 'person1@example.com' : 'PROJ-17', j.str(p), hash(p), v, type === 'jira_update' ? jira().version : 0, 'pending', addDays(now, 2), now, reissue]);
    return id;
  }
  async function ensureLivePrepared(ids: string[]) {
    if (engine !== 'openai') return;
    if (!live) throw new Error('live_adapter_missing');
    for (const id of ids) {
      if (db.get('SELECT id FROM sdk_snapshots WHERE approval_id=?', [id])) continue;
      const prepared = await live.prepare(id);
      db.run('INSERT INTO sdk_snapshots(approval_id,engine,snapshot,meta_json,created_at,updated_at) VALUES(?,?,?,?,?,?)', [id, 'openai', prepared.snapshot, j.str(prepared.meta ?? {}), now, now]);
    }
  }
  function requiredExecuted() {
    const v = Number(goal().task_version);
    const sent = db.get('SELECT o.id FROM outcomes o JOIN approvals a ON a.id=o.action_id WHERE a.task_version=? AND a.action_type=? AND o.status=?', [v, 'send_message', 'success']);
    const jiraDone = db.get('SELECT o.id FROM outcomes o JOIN approvals a ON a.id=o.action_id WHERE a.task_version=? AND a.action_type=? AND o.status=?', [v, 'jira_update', 'success']);
    return Boolean(sent && jiraDone);
  }
  function refreshGoalStatus() {
    if (requiredExecuted()) db.run("UPDATE goals SET status='완료', wait_condition='', next_step='실행 이력 확인', updated_at=? WHERE id='proposal'", [now]);
    else db.run("UPDATE goals SET status='승인 대기', wait_condition='사용자 HITL 승인', next_step='남은 승인/실행 처리', updated_at=? WHERE id='proposal'", [now]);
  }
  async function advanceGoal(reason = 'manual'): Promise<DecideResult> {
    const ids = db.tx(() => {
      const g = goal();
      if (g.status === '완료' && requiredExecuted()) return [] as string[];
      if (!g.due_date) return [] as string[];
      saveDraft();
      if (!g.quote) {
        db.run("UPDATE goals SET status='회신 대기', wait_condition='견적 회신 대기', next_step='견적 도착 이벤트를 기다림', next_check_at=?, updated_at=? WHERE id='proposal'", [addDays(now, 1), now]);
        return [] as string[];
      }
      const made = [createApproval('send_message'), createApproval('jira_update')];
      refreshGoalStatus();
      db.run('UPDATE goals SET next_check_at=? WHERE id=?', [addDays(now, 1), 'proposal']);
      return made;
    });
    if (!goal().due_date) return { status: 'waiting', reason: 'no_request' };
    if (!goal().quote) return { status: 'waiting', reason: 'quote' };
    await ensureLivePrepared(ids);
    return ids.length ? { status: 'approval_required', approvals: ids, reason } : { status: goal().status === '완료' ? 'complete' : 'approval_required', approvals: [] };
  }
  function privateApproval(id: string) { return db.get<any>('SELECT * FROM approvals WHERE id=?', [id]); }
  function validateApproval(a: any, forCommit = false) {
    if (!a) return 'missing';
    if (a.status === 'executed') return 'executed';
    if (forCommit) {
      if (a.status !== 'processing' || a.decision_note !== 'approved') return 'not_authorized';
    } else if (!['pending', 'deferred'].includes(a.status)) return a.status;
    const g = goal(); const p = j.parse<any>(a.payload_json, {});
    const currentTime = Date.parse(now); const expiresAt = Date.parse(a.expires_at);
    if (!Number.isFinite(currentTime) || !Number.isFinite(expiresAt)) return 'stale';
    if (currentTime > expiresAt) return 'expired';
    if (Number(a.task_version) !== Number(g.task_version)) return 'stale';
    if (hash(p) !== a.payload_hash) return 'stale';
    if (a.action_type === 'send_message') {
      if (a.target !== 'person1@example.com' || p.recipient !== a.target || p.channel !== 'outlook' || p.dueDate !== g.due_date || p.quote !== g.quote || Number(a.target_version) !== 0) return 'stale';
    } else if (a.action_type === 'jira_update') {
      const target = jira();
      if (a.target !== target.key || p.target !== a.target || p.fromVersion !== Number(a.target_version) || Number(a.target_version) !== Number(target.version)) return 'stale';
    } else return 'stale';
    return 'ok';
  }
  function markInvalid(id: string, status: string): DecideResult {
    db.run('UPDATE approvals SET status=?, decided_at=?, decision_note=? WHERE id=? AND status<>?', [status, now, status === 'expired' ? '만료' : '대상/내용/버전 변경', id, 'executed']);
    return { status };
  }
  function reserveApproval(id: string) {
    return db.tx(() => {
      const a = privateApproval(id); const valid = validateApproval(a, false);
      if (valid !== 'ok') {
        if (valid === 'executed') return { ok: false, result: { status: 'already_executed' } };
        return { ok: false, result: valid === 'stale' || valid === 'expired' ? markInvalid(id, valid) : { status: valid } };
      }
      const r = db.run("UPDATE approvals SET status='processing', decision_note='approved', decided_at=? WHERE id=? AND status IN ('pending','deferred')", [now, id]);
      if (r.changes !== 1) return { ok: false, result: { status: privateApproval(id)?.status ?? 'missing' } };
      return { ok: true, result: { status: 'processing' } };
    });
  }
  function commitApprovedAction(id: string) {
    return db.tx(() => {
      const a = privateApproval(id); const valid = validateApproval(a, true);
      if (valid === 'executed') return { status: 'already_executed' };
      if (valid !== 'ok') return valid === 'stale' || valid === 'expired' ? markInvalid(id, valid) : { status: valid };
      const p = j.parse<any>(a.payload_json, {});
      const result = a.action_type === 'jira_update' ? executeJira(id, p) : executeSend(id, p);
      db.run("UPDATE approvals SET status='executed', decided_at=? WHERE id=?", [now, id]);
      refreshGoalStatus();
      return result;
    });
  }
  // Legacy mock effects are committed atomically with their local outcome.
  // This evidence does not establish absence of any real company-side write.
  function inspectMockReconciliation(id: string) {
    const approval = privateApproval(id);
    if (!approval) throw new Error('approval_not_found');
    if (approval.status !== 'uncertain' && approval.status !== 'processing') return { status: approval.status, evidence: 'not_available' as const };
    const payload = j.parse<any>(approval.payload_json, null);
    const supported = payload && hash(payload) === approval.payload_hash && ((approval.action_type === 'send_message' && approval.target === 'person1@example.com' && payload.recipient === approval.target && payload.channel === 'outlook') || (approval.action_type === 'jira_update' && approval.target === 'PROJ-17' && payload.target === approval.target && Number(payload.fromVersion) === Number(approval.target_version)));
    const outcome = db.get<any>('SELECT * FROM outcomes WHERE action_id=?', [id]);
    const scope = { id, actionType: approval.action_type, target: approval.target, taskVersion: approval.task_version, targetVersion: approval.target_version, payloadHash: approval.payload_hash, expiresAt: approval.expires_at };
    if (approval.status === 'processing') {
      if (!supported || approval.decision_note !== 'approved') return { status: 'processing', evidence: 'not_available' as const };
      const recoveryToken = hash({ scope, status: approval.status, decision: approval.decision_note, decidedAt: approval.decided_at, outcome: outcome ? { id: outcome.id, action_type: outcome.action_type, status: outcome.status, result_json: outcome.result_json } : null });
      return { status: 'processing', evidence: 'recovery_available' as const, scope, recoveryToken };
    }
    let evidence: 'mock_no_effect' | 'mock_effect_recorded' | 'unresolved' = 'unresolved';
    if (supported && !outcome) evidence = 'mock_no_effect';
    if (supported && outcome?.status === 'success' && outcome.action_type === approval.action_type) {
      const result = j.parse<any>(outcome.result_json, null);
      if (result?.mock === true && result.payload && typeof result.payload === 'object' && hash(result.payload) === approval.payload_hash && (approval.action_type === 'send_message' ? result.messageId === `mock-${id}` : result.jiraBefore?.key === approval.target && Number(result.jiraBefore?.version) === Number(approval.target_version))) evidence = 'mock_effect_recorded';
    }
    const reviewToken = hash({ scope, evidence, outcome: outcome ? { id: outcome.id, action_type: outcome.action_type, status: outcome.status, result_json: outcome.result_json } : null });
    return { status: 'uncertain', scope, evidence, reviewToken };
  }
  // Only the built-in mock commits are supported. Their effect, outcome and
  // status share one SQLite transaction; fencing processing prevents a late
  // callback from committing even when another service instance is running.
  function recoverMockProcessing(id: string, recoveryToken: unknown) {
    return db.tx(() => {
      const preview = inspectMockReconciliation(id);
      if (preview.status !== 'processing' || !('recoveryToken' in preview)) throw new Error('mock_recovery_unavailable');
      if (typeof recoveryToken !== 'string' || recoveryToken !== preview.recoveryToken) throw new Error('stale_mock_recovery');
      const changed = db.run("UPDATE approvals SET status='uncertain',decision_note='local mock processing fenced for review',decided_at=? WHERE id=? AND status='processing' AND decision_note='approved'", [now, id]);
      if (changed.changes !== 1) throw new Error('stale_mock_recovery');
      db.run('INSERT INTO mock_processing_recoveries(approval_id,payload_hash,review_token,reviewer,created_at) VALUES(?,?,?,?,?)', [id, preview.scope!.payloadHash, recoveryToken, 'local', now]);
      return { status: 'uncertain' };
    });
  }
  function reconcileMockApproval(id: string, reviewToken: unknown) {
    return db.tx(() => {
      const preview = inspectMockReconciliation(id);
      if (preview.status !== 'uncertain' || !('reviewToken' in preview)) throw new Error('approval_not_uncertain');
      if (typeof reviewToken !== 'string' || reviewToken !== preview.reviewToken) throw new Error('stale_reconciliation');
      if (preview.evidence === 'unresolved') return { status: 'uncertain', evidence: preview.evidence };
      const resolution = preview.evidence === 'mock_no_effect' ? 'reconciled_no_effect' : 'executed';
      db.run('INSERT INTO mock_effect_reconciliations(approval_id,resolution,payload_hash,evidence_json,reviewer,created_at) VALUES(?,?,?,?,?,?)', [id, resolution, preview.scope!.payloadHash, j.str({ evidence: preview.evidence, reviewToken }), 'local', now]);
      db.run('UPDATE approvals SET status=?,decision_note=?,decided_at=? WHERE id=? AND status=?', [resolution, `verified local ${preview.evidence}`, now, id, 'uncertain']);
      refreshGoalStatus();
      return { status: resolution, evidence: preview.evidence };
    });
  }
  async function decide(id: string, decision: Decision, edit?: { body?: string; comment?: string }): Promise<DecideResult> {
    const a0 = privateApproval(id);
    if (!a0) throw new Error('approval_not_found');
    if (a0.status === 'executed') return { status: 'already_executed' };
    if (decision === 'defer') {
      const r = db.run("UPDATE approvals SET status='deferred', decided_at=?, decision_note='나중에' WHERE id=? AND status IN ('pending','deferred')", [now, id]);
      return { status: r.changes ? 'deferred' : privateApproval(id)?.status ?? 'missing' };
    }
    if (decision === 'reject') {
      const r = db.run("UPDATE approvals SET status='rejecting', decided_at=?, decision_note='rejected' WHERE id=? AND status IN ('pending','deferred')", [now, id]);
      if (r.changes !== 1) return { status: privateApproval(id)?.status ?? 'missing' };
      if (engine === 'openai') { try { await resumeLive(id, false, false); } catch { /* rejection is already durable; never execute on SDK failure */ } }
      db.run("UPDATE approvals SET status='rejected', decided_at=?, decision_note='rejected' WHERE id=? AND status='rejecting'", [now, id]);
      refreshGoalStatus(); return { status: 'rejected' };
    }
    if (decision === 'expire') {
      const r = db.run("UPDATE approvals SET status='expired', decided_at=?, decision_note='만료' WHERE id=? AND status IN ('pending','deferred')", [now, id]);
      return { status: r.changes ? 'expired' : privateApproval(id)?.status ?? 'missing' };
    }
    if (decision === 'edit') return editApproval(id, edit);
    if (decision !== 'approve') throw new Error('bad_decision');
    const reserved = reserveApproval(id);
    if (!reserved.ok) return reserved.result;
    if (engine === 'openai') {
      try { await resumeLive(id, true, true); }
      catch (e) { db.run("UPDATE approvals SET status='uncertain', decision_note='SDK outcome requires reconciliation' WHERE id=? AND status='processing'", [id]); throw e; }
      db.run("UPDATE approvals SET status='uncertain', decision_note='SDK returned without a confirmed outcome' WHERE id=? AND status='processing'", [id]);
      return privateApproval(id)?.status === 'executed' ? { status: 'executed' } : { status: privateApproval(id)?.status ?? 'unknown' };
    }
    return commitApprovedAction(id) as DecideResult;
  }
  async function resumeLive(id: string, approve: boolean, requireSnapshot: boolean) {
    if (!live) throw new Error('live_adapter_missing');
    const snap = db.get<any>('SELECT * FROM sdk_snapshots WHERE approval_id=?', [id]);
    if (!snap && requireSnapshot) throw new Error('sdk_snapshot_missing');
    if (!snap) return;
    const res = await live.decide(id, snap.snapshot, approve);
    db.run('UPDATE sdk_snapshots SET snapshot=?, meta_json=?, updated_at=? WHERE approval_id=?', [res.snapshot, j.str(res.meta ?? {}), now, id]);
  }
  function editApproval(id: string, edit?: { body?: string; comment?: string }): DecideResult {
    return db.tx(() => {
      const a = privateApproval(id); const valid = validateApproval(a, false);
      if (valid !== 'ok') {
        if (valid === 'executed') return { status: 'already_executed' };
        return valid === 'stale' || valid === 'expired' ? markInvalid(id, valid) : { status: valid };
      }
      const p = j.parse<any>(a.payload_json, {});
      if (a.action_type === 'send_message') {
        if (!edit?.body || edit.body.length > 4000) throw new Error('bad_edit');
        p.body = edit.body;
      } else {
        if (!edit?.comment || edit.comment.length > 1000) throw new Error('bad_edit');
        p.comment = edit.comment;
      }
      const reissue = nextReissue(a.action_type, Number(a.task_version)); const nid = `${a.action_type}-v${a.task_version}-r${reissue}`;
      db.run("UPDATE approvals SET status='stale', decided_at=?, decision_note='사용자 수정으로 재승인 필요' WHERE id=?", [now, id]);
      db.run('INSERT INTO approvals(id,action_type,target,payload_json,payload_hash,task_version,target_version,status,expires_at,created_at,reissue) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [nid, a.action_type, a.target, j.str(p), hash(p), a.task_version, a.target_version, 'pending', addDays(now, 2), now, reissue]);
      return { status: 'edited', newApprovalId: nid };
    });
  }
  function executeSend(id: string, p: unknown) {
    db.run('INSERT OR IGNORE INTO outcomes(action_id,action_type,status,result_json,created_at) VALUES(?,?,?,?,?)', [id, 'send_message', 'success', j.str({ mock: true, messageId: `mock-${id}`, payload: p }), now]);
    return { status: 'executed' };
  }
  function executeJira(id: string, p: any) {
    const r = db.run('INSERT OR IGNORE INTO outcomes(action_id,action_type,status,result_json,created_at) VALUES(?,?,?,?,?)', [id, 'jira_update', 'success', j.str({ mock: true, jiraBefore: jira(), payload: p }), now]);
    if (r.changes !== 0) { const cur = jira(); setKv('jira', j.str({ ...cur, version: Number(cur.version) + 1, status: p.setStatus })); }
    return { status: 'executed' };
  }
  function advanceClock(kind: 'day' | 'week' = 'day') {
    const previous = now;
    now = addDays(now, kind === 'week' ? 7 : 1);
    try {
      return db.tx(() => {
        setKv('clock', now);
        let content = makeDigest(kind);
        if (kind === 'week') {
          const s = state();
          content = runLocalArtifact({ goalId: 'legacy:weekly', title: 'Weekly review', completion: 'Report', kind: 'weekly-ops', source: 'local:operation-counts', fact: j.str({ duplicateCount: s.duplicateCount, pendingApprovals: s.approvals.filter((a:any) => a.status === 'pending').length }), content });
        }
        db.run('INSERT INTO digests(kind,content,created_at) VALUES(?,?,?)', [kind === 'week' ? 'weekly-ops' : 'daily-briefing', content, now]);
        db.run("UPDATE approvals SET status='expired', decided_at=?, decision_note='만료' WHERE status IN ('pending','deferred') AND expires_at < ?", [now, now]);
        return { now };
      });
    } catch (error) { now = previous; throw error; }
  }
  function makeDigest(kind: string) { const s = state(); const g = s.goal; return kind === 'week' ? `주간 운영 점검: 실제 중복 재생 ${s.duplicateCount}건, 승인 대기 ${s.approvals.filter((a:any)=>a.status==='pending').length}건` : `오늘 브리핑: ${g.next_step}; 대기 조건 ${g.wait_condition || '없음'}`; }
  function ingestFixture(index: number) { if (!Number.isInteger(index) || index < 0 || index >= fixtures.length) throw new Error('invalid_fixture_index'); return ingest(fixtures[index]); }
  function ingestAll() { return fixtures.map(ingest); }
  function state() {
    const approvals = db.all<any>('SELECT * FROM approvals ORDER BY created_at,id').map(publicApproval);
    return { mode: engine, liveSdk: engine === 'openai', now, goal: goal(), todos: db.all('SELECT * FROM todos'), latestDraft: db.get('SELECT * FROM artifacts ORDER BY version DESC LIMIT 1'), latestAnalysis: latestAnalysis(), approvals, outcomes: db.all('SELECT * FROM outcomes ORDER BY id'), events: db.all('SELECT id,source_event_id,source,project,kind,title,occurred_at,processed_at FROM events ORDER BY id'), duplicateCount: db.get<{ c: number }>('SELECT count(*) c FROM duplicate_attempts')?.c ?? 0, evidence: db.all<any>(`SELECT 'ev-'||e.id AS id,e.source,ev.source_event_id AS sourceEventId,ev.occurred_at AS occurredAt,e.title,e.excerpt,e.trusted FROM evidence e JOIN events ev ON ev.id=e.event_id ORDER BY e.id DESC LIMIT 8`), digests: db.all('SELECT * FROM digests ORDER BY id DESC LIMIT 5'), messages: messages(), sdkSnapshotCount: db.get<{ c: number }>('SELECT count(*) c FROM sdk_snapshots')?.c ?? 0, sdkMeta: db.all<any>('SELECT approval_id,engine,meta_json,created_at,updated_at FROM sdk_snapshots').map((r:any)=>({ ...r, meta: j.parse(r.meta_json, {}) })), jira: jira() };
  }
  function messages() {
    return db.all<any>(`SELECT m.id,m.role,CASE WHEN c.version IS NULL THEN m.content ELSE c.content END AS content,m.analysis_id AS analysisId,m.created_at AS createdAt,COALESCE(c.version,0) AS version
      FROM messages m LEFT JOIN memory_message_corrections c ON c.message_id=m.id AND c.version=(SELECT MAX(version) FROM memory_message_corrections WHERE message_id=m.id)
      WHERE c.version IS NULL OR c.content IS NOT NULL ORDER BY m.id DESC LIMIT 40`).reverse();
  }
  function addMessage(input: { role?: unknown; content?: unknown; analysisId?: unknown }) {
    const role = input.role === 'assistant' ? 'assistant' : 'user';
    if (typeof input.content !== 'string') throw new Error('bad_message');
    const content = input.content.trim();
    if (!content || content.length > 2000) throw new Error('bad_message');
    const analysisId = Number.isInteger(input.analysisId) ? Number(input.analysisId) : null;
    db.run('INSERT INTO messages(role,content,analysis_id,created_at) VALUES(?,?,?,?)', [role, content, analysisId, now]);
    return messages();
  }
  function workspaceGoal(id: string) {
    const row = db.get<{ id: string; current_plan: number; project: string }>('SELECT g.id,g.current_plan,p.project FROM workspace_goals w JOIN workflow_goals g ON g.id=w.goal_id JOIN workflow_goal_projects p ON p.goal_id=g.id WHERE w.goal_id=? AND w.owner=? AND g.owner=?', [id, 'local', 'local']);
    if (!row) throw new Error('workspace_goal_not_found');
    return row;
  }
  function createWorkspaceGoal(input: { title?: unknown; completion?: unknown; project?: unknown }) {
    if (typeof input.project !== 'string' || !db.get('SELECT id FROM events WHERE project=? LIMIT 1', [input.project])) throw new Error('unknown_project');
    if (typeof input.title !== 'string' || typeof input.completion !== 'string') throw new Error('invalid_goal');
    const id = `goal-${crypto.randomUUID()}`;
    return db.tx(() => {
      workflow.createGoal({ id, title: input.title as string, owner: 'local', completion: input.completion as string });
      workflow.bindProject(id, input.project as string);
      db.run('INSERT INTO workspace_goals(goal_id,owner) VALUES(?,?)', [id, 'local']);
      return { id, project: input.project };
    });
  }
  function workspaceGoals() {
    return db.all('SELECT g.id,g.title,g.completion,g.current_plan,p.project FROM workspace_goals w JOIN workflow_goals g ON g.id=w.goal_id JOIN workflow_goal_projects p ON p.goal_id=g.id WHERE w.owner=? AND g.owner=? ORDER BY g.created_at,g.id', ['local', 'local']);
  }
  function workspaceProjects() { return db.all('SELECT DISTINCT project FROM events WHERE project IS NOT NULL AND length(trim(project))>0 ORDER BY project'); }
  function inspectWorkspaceGoal(id: string) { workspaceGoal(id); return { ...workflow.inspect(id), approvals: workspaceApprovals.inspect(id), outcomes: workspaceApprovals.outcomes(id), automation: automation.inspect(id), improvements: workspaceImprovements.list(id) }; }
  function completeWorkspacePersonalTask(goalId: string, taskId: unknown, expectedPlanVersion: unknown) { workspaceGoal(goalId); return workflow.completePersonalTask(goalId, taskId, expectedPlanVersion); }
  function discordWorkspaceContext() {
    const goals = workspaceGoals() as Array<{ id: string; title: string; completion: string; current_plan: number; project: string }>;
    return { totalGoals: goals.length, goals: goals.slice(0, 8).map(g => {
      const steps = db.all<{ step_id: string; tool: string; status: string }>('SELECT step_id,tool,status FROM workflow_steps WHERE goal_id=? AND plan_version=? ORDER BY position LIMIT 8', [g.id, g.current_plan]);
      const artifacts = db.all<{ id: number; kind: string; content: string; plan_version: number; source: string; observed_at: string }>('SELECT a.id,a.kind,a.content,a.plan_version,f.source,f.observed_at FROM workflow_artifacts a JOIN workflow_facts f ON f.id=a.source_fact_id AND f.goal_id=a.goal_id AND f.plan_version=a.plan_version WHERE a.goal_id=? AND a.plan_version=? ORDER BY a.id DESC LIMIT 2', [g.id, g.current_plan]).map(a => ({ ...a, content: a.content.slice(0, 1000) }));
      const sources = db.all<{ source: string; reference: string; occurredAt: string; excerpt: string }>('SELECT ev.source,ev.source_event_id AS reference,ev.occurred_at AS occurredAt,e.excerpt FROM evidence e JOIN events ev ON ev.id=e.event_id WHERE ev.project=? AND e.trusted=1 ORDER BY ev.occurred_at DESC,e.id DESC LIMIT 4', [g.project]);
      const jobs = db.all<{ kind: string; status: string; reason: string | null; due_at: number }>("SELECT kind,status,reason,due_at FROM scheduler_jobs WHERE goal_id=? AND status IN ('pending','running','held','failed','stopped') ORDER BY updated_at DESC LIMIT 4", [g.id]);
      const approvals = workspaceApprovals.inspect(g.id).filter((a: any) => a.effectiveStatus === 'pending').slice(0, 4).map((a: any) => ({ id: a.id, status: a.effectiveStatus, planVersion: a.plan_version }));
      return { ...g, steps, artifacts, sources, jobs, approvals };
    }) };
  }
  async function planWorkspaceGoal(id: string, expectedVersion: unknown, hooks?: { signal?: AbortSignal; beforeCommit?: () => void; afterCommit?: (version: number) => void; schedulerLease?: { jobId: string; runId: string; leaseToken: string } }) {
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0) throw new Error('invalid_plan_version');
    db.tx(() => {
      hooks?.beforeCommit?.();
      const g = workspaceGoal(id);
      if (g.current_plan !== expectedVersion) throw new Error('stale_plan');
      if (g.current_plan >= 12) throw new Error('planner_replan_budget_exceeded');
      const attempts = db.get<{ n: number }>('SELECT count(*) AS n FROM workflow_planner_attempts WHERE goal_id=?', [id])!.n;
      if (attempts >= 24) throw new Error('planner_attempt_budget_exceeded');
      const prior = db.get<{ version: number }>('SELECT version FROM workflow_planner_policies WHERE goal_id=? ORDER BY version DESC LIMIT 1', [id]);
      const configured = workflow.configurePlannerFromEvidence(id, prior?.version ?? 0, { allowedArtifactKinds: ['draft'], maxSteps: 8, maxFactCalls: 4, maxArtifactCalls: 3, maxTextChars: 5000, maxPlanVersions: 12, maxPlannerAttempts: 24 });
      if (!configured.facts.length) throw new Error('needs_evidence');
    });
    const offlinePlanner: PlannerAdapter = async context => {
      const terms = [...new Set(`${context.goal.title} ${context.goal.completion}`.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 20);
      const fact = context.facts.map((item, index) => ({ item, index, score: terms.reduce((n, term) => n + (item.value.toLocaleLowerCase().includes(term) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score || a.index - b.index)[0]?.item;
      if (!fact) throw new Error('needs_evidence');
      const evidenceId = /^evidence:(\d+)$/.exec(fact.key)?.[1];
      const source = evidenceId ? db.get<{ source: string; source_event_id: string; external_id: string | null }>('SELECT ev.source,ev.source_event_id,m.external_id FROM evidence e JOIN events ev ON ev.id=e.event_id LEFT JOIN mock_connector_events m ON m.event_id=ev.id WHERE e.id=?', [Number(evidenceId)]) : undefined;
      const sourceLabel = source ? `${source.source}:${source.external_id ?? source.source_event_id}` : fact.source;
      const brief = context.memory.preferences.some(p => p.key === 'response_style' && p.value === 'brief');
      const previous = context.memory.conversation.filter(m => m.role === 'user').at(-1);
      const content = [
        `목표: ${context.goal.title.slice(0, 200)}`,
        `완료 조건: ${context.goal.completion.slice(0, 300)}`,
        `수집된 근거 (${sourceLabel}, ${fact.observedAt}): ${fact.value}`,
        ...(!brief && previous ? [`이전 사용자 대화 (${previous.source}): ${previous.content.slice(0, 400)}`] : []),
        '검토용 초안이며 공유 작업은 실행하지 않았습니다.'
      ].join('\n');
      return { steps: [
        { id: 'evidence', tool: 'record_fact', dependsOn: [], input: fact },
        { id: 'draft', tool: 'create_artifact', dependsOn: ['evidence'], input: { kind: 'draft', content, factStepId: 'evidence' } }
      ] };
    };
    if (!planner) planner = opts.plannerAdapterFactory ? opts.plannerAdapterFactory() : engine === 'openai' && !opts.liveAdapterFactory ? createOpenAIPlannerAdapter() : offlinePlanner;
    const version = await workflow.planWithAdapter(id, Number(expectedVersion), planner, opts.plannerTimeoutMs, hooks);
    return { version, workflow: workflow.inspect(id) };
  }
  async function continueWorkspaceGoal(ctx: HandlerContext, eventId: number, checkCurrent: () => void, signal: AbortSignal) {
    const state = db.tx(() => {
      checkCurrent();
      const g = workspaceGoal(ctx.goalId);
      const existing = db.get<{ plan_version: number }>('SELECT plan_version FROM workspace_event_plans WHERE effect_id=? AND goal_id=? AND event_id=?', [ctx.effectId, ctx.goalId, eventId]);
      return { current: g.current_plan, planned: existing?.plan_version };
    });
    // An explicit initial plan opts the goal into local event continuation.
    if (!state.current) return {};
    if (state.planned && state.planned !== state.current) return {};
    let version = state.planned;
    if (!version) {
      const result = await planWorkspaceGoal(ctx.goalId, state.current, {
        signal, beforeCommit: checkCurrent,
        schedulerLease: { jobId: ctx.jobId, runId: ctx.runId, leaseToken: ctx.leaseToken },
        afterCommit: planned => db.run('INSERT INTO workspace_event_plans(effect_id,goal_id,event_id,plan_version) VALUES(?,?,?,?)', [ctx.effectId, ctx.goalId, eventId, planned])
      });
      version = result.version;
    }
    db.tx(() => {
      checkCurrent();
      // All currently supported tools are local, bounded and idempotent by plan/step.
      for (let n = 0; n < 8; n++) {
        const result = workflow.runNext(ctx.goalId, version!);
        if (result.status === 'complete' || result.status === 'waiting') return;
      }
      if (db.get("SELECT step_id FROM workflow_steps WHERE goal_id=? AND plan_version=? AND status IN ('pending','waiting') LIMIT 1", [ctx.goalId, version!])) throw new Error('event_tool_budget_exceeded');
    });
    return { plannedVersion: version };
  }
  function runWorkspaceGoal(id: string, version: unknown) {
    workspaceGoal(id);
    if (!Number.isSafeInteger(version) || Number(version) < 1) throw new Error('invalid_plan_version');
    return workflow.runNext(id, Number(version));
  }
  function discordCommandId(messageId: unknown) {
    if (typeof messageId !== 'string' || !/^\d{1,22}$/.test(messageId)) throw new Error('invalid_discord_message_id');
    return messageId;
  }
  function priorDiscordCommand(messageId: string, action: string, signature: string) {
    const row = db.get<{ action: string; request_hash: string; response_json: string }>('SELECT action,request_hash,response_json FROM discord_commands WHERE message_id=?', [messageId]);
    if (!row) return undefined;
    if (row.action !== action || row.request_hash !== signature) throw new Error('discord_command_conflict');
    return j.parse<any>(row.response_json, null);
  }
  function saveDiscordCommand(messageId: string, action: string, signature: string, result: unknown) {
    db.run('INSERT INTO discord_commands(message_id,action,request_hash,response_json,created_at) VALUES(?,?,?,?,?)', [messageId, action, signature, j.str(result), now]);
  }
  function discordCreateGoal(messageIdValue: unknown, input: { project?: unknown; title?: unknown; completion?: unknown }) {
    const messageId = discordCommandId(messageIdValue), signature = hash(input);
    return db.tx(() => {
      const prior = priorDiscordCommand(messageId, 'create_goal', signature); if (prior) return prior;
      const created = createWorkspaceGoal(input);
      memory.rememberScoped(`discord:message:${messageId}`, String(input.project), 'local', `${String(input.title)}\n${String(input.completion)}`);
      const result = { status: 'created', goalId: created.id, project: created.project };
      saveDiscordCommand(messageId, 'create_goal', signature, result); return result;
    });
  }
  function discordRemember(messageIdValue: unknown, project: unknown, content: unknown) {
    const messageId = discordCommandId(messageIdValue), signature = hash({ project, content });
    return db.tx(() => {
      const prior = priorDiscordCommand(messageId, 'remember', signature); if (prior) return prior;
      if (typeof project !== 'string' || !db.get('SELECT id FROM events WHERE project=? LIMIT 1', [project])) throw new Error('unknown_project');
      const saved = memory.rememberScoped(`discord:message:${messageId}`, project, 'local', content as string);
      const result = { status: 'remembered', project, sourceId: saved.sourceId };
      saveDiscordCommand(messageId, 'remember', signature, result); return result;
    });
  }
  async function discordPlanGoal(messageIdValue: unknown, goalId: string) {
    const messageId = discordCommandId(messageIdValue), signature = hash({ goalId });
    const prior = priorDiscordCommand(messageId, 'plan_goal', signature); if (prior) return prior;
    const inFlight = inFlightDiscordPlans.get(messageId);
    if (inFlight) { if (inFlight.signature !== signature) throw new Error('discord_command_conflict'); return inFlight.promise; }
    const promise = (async () => {
      const g = workspaceGoal(goalId);
      try {
        const planned = await planWorkspaceGoal(goalId, g.current_plan, { afterCommit: version => saveDiscordCommand(messageId, 'plan_goal', signature, { status: 'planned', goalId, version }) });
        return { status: 'planned', goalId, version: planned.version };
      } catch (error) {
        if (!(error instanceof PlannerAttemptFailure) && (!(error instanceof Error) || error.message !== 'needs_evidence')) throw error;
        return db.tx(() => {
          const existing = priorDiscordCommand(messageId, 'plan_goal', signature); if (existing) return existing;
          const result = error instanceof PlannerAttemptFailure ? { status: 'plan_failed', goalId, attemptId: error.attemptId, code: error.code } : { status: 'needs_evidence', goalId };
          saveDiscordCommand(messageId, 'plan_goal', signature, result); return result;
        });
      }
    })();
    inFlightDiscordPlans.set(messageId, { signature, promise });
    try { return await promise; } finally { inFlightDiscordPlans.delete(messageId); }
  }
  function discordStepGoal(messageIdValue: unknown, goalId: string) {
    const messageId = discordCommandId(messageIdValue), signature = hash({ goalId });
    return db.tx(() => {
      const prior = priorDiscordCommand(messageId, 'step_goal', signature); if (prior) return prior;
      const g = workspaceGoal(goalId);
      const result = g.current_plan ? { ...workflow.runNext(goalId, g.current_plan), goalId, version: g.current_plan } : { status: 'needs_plan', goalId };
      saveDiscordCommand(messageId, 'step_goal', signature, result); return result;
    });
  }
  function artifacts() {
    const draft = db.get<any>('SELECT * FROM artifacts ORDER BY version DESC LIMIT 1');
    const analysis = latestAnalysis();
    return {
      items: [
        draft ? { id: 'latest-draft', kind: 'draft', title: `제안서 회신 초안 v${draft.version}`, createdAt: draft.created_at, content: draft.content, evidence: j.parse(draft.evidence_json, {}) } : undefined,
        analysis ? { id: 'latest-analysis', kind: 'analysis', title: `AI 제안: ${analysis.normalizedGoal}`, createdAt: analysis.createdAt, stale: analysis.stale, content: (analysis.output as any)?.draftProposal?.body ?? '', output: analysis.output, sources: analysis.evidenceSources } : undefined,
        { id: 'architecture-overview', kind: 'image', title: '업무 비서 흐름 개요', createdAt: '2026-10-27', imagePng: '/api/assets/architecture-overview.svg', imageSvg: '/api/assets/architecture-overview.svg', content: '합성 업무 입력 -> 업무 비서 -> 사람 승인 -> 모의 실행/기록의 단순 흐름 개요입니다.' }
      ].filter(Boolean)
    };
  }
  return { db, workflow, memory, mockConnectors, workspaceApprovals, workspaceImprovements, notifications, automation, createWorkspaceGoal, workspaceGoals, workspaceProjects, inspectWorkspaceGoal, completeWorkspacePersonalTask, discordWorkspaceContext, discordCreateGoal, discordRemember, discordPlanGoal, discordStepGoal, planWorkspaceGoal, runWorkspaceGoal, ingest, ingestFixture, ingestAll, advanceGoal, analyzeGoal, decide, inspectMockReconciliation, recoverMockProcessing, reconcileMockApproval, advanceClock, addMessage, messages, artifacts, commitApprovedAction, state, close: () => { workflow.close(); db.close(); } };
}
