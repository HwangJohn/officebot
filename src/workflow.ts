import type { Db } from './db.js';
import { j } from './db.js';
import { createMemory, type MemoryContext } from './memory.js';
import { PlannerAttemptFailure, PlannerDiagnostic, plannerCode } from './plannerDiagnostics.js';

// These tools read project-scoped mocks or write only local records; none executes shared work.
export type WorkflowStep = {
  id: string;
  dependsOn: string[];
} & ({ tool: 'record_fact'; input: { key: string; value: string; source: string; observedAt: string } }
  | { tool: 'create_artifact'; input: { kind: string; content: string; factStepId: string } }
  | { tool: 'wait_for_mock_record'; input: { source: 'teams' | 'outlook' | 'jira' | 'confluence'; account: string; externalId: string } }
  | { tool: 'personal_followup'; input: { taskKey: string; title: string; factStepId: string } });

// This policy is supplied by the host, never by a planner proposal.
export type PlannerPolicy = {
  allowedSources: string[];
  // Authoritative snapshots must come from the host, not from generated text.
  trustedFacts: Array<{ source: string; key: string; value: string; observedAt: string }>;
  allowedArtifactKinds: string[];
  maxSteps: number;
  maxFactCalls: number;
  maxArtifactCalls: number;
  maxTextChars: number;
  maxPlanVersions: number;
  maxPlannerAttempts: number;
};
type EvidencePolicy = Pick<PlannerPolicy, 'allowedArtifactKinds' | 'maxSteps' | 'maxFactCalls' | 'maxArtifactCalls' | 'maxTextChars' | 'maxPlanVersions' | 'maxPlannerAttempts'>;
export type PlannerAdapter = (input: { goal: { id: string; title: string; completion: string }; facts: PlannerPolicy['trustedFacts']; currentRecords?: { records: { source: string; account: string; externalId: string; revision: number; occurredAt: string; factKey: string | null }[]; truncated: boolean }; memory: MemoryContext; personalTasks: { taskKey: string; title: string; status: string }[]; allowedArtifactKinds: string[]; maxSteps: number; signal: AbortSignal }) => Promise<unknown>;

function nonempty(value: unknown, max = 2000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function exactObject(value: unknown, keys: string[]): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateSteps(steps: unknown): asserts steps is WorkflowStep[] {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 32) throw new Error('invalid_plan_size');
  const seen = new Map<string, { tool: string; ancestors: Set<string> }>();
  for (const step of steps) {
    if (!exactObject(step, ['id', 'tool', 'input', 'dependsOn'])) throw new Error('invalid_step_schema');
    if (!nonempty(step.id, 100) || seen.has(step.id) || !Array.isArray(step.dependsOn) || new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(id => !nonempty(id, 100) || !seen.has(id))) throw new Error('invalid_step_dependencies');
    const ancestors = new Set<string>();
    for (const id of step.dependsOn) { ancestors.add(id); for (const ancestor of seen.get(id)!.ancestors) ancestors.add(ancestor); }
    if (step.tool === 'record_fact') {
      const input = step.input;
      if (!exactObject(input, ['key', 'value', 'source', 'observedAt']) || !nonempty(input.key, 100) || !nonempty(input.value) || !nonempty(input.source, 200) || !nonempty(input.observedAt, 50) || !Number.isFinite(Date.parse(input.observedAt))) throw new Error('invalid_fact');
    } else if (step.tool === 'create_artifact') {
      const input = step.input;
      if (!exactObject(input, ['kind', 'content', 'factStepId']) || !nonempty(input.kind, 100) || !nonempty(input.content) || !nonempty(input.factStepId, 100) || !ancestors.has(input.factStepId) || seen.get(input.factStepId)?.tool !== 'record_fact') throw new Error('invalid_artifact');
    } else if (step.tool === 'wait_for_mock_record') {
      const input = step.input;
      if (!exactObject(input, ['source', 'account', 'externalId']) || !['teams', 'outlook', 'jira', 'confluence'].includes(input.source) || typeof input.account !== 'string' || !/^mock:[a-zA-Z0-9_-]{1,80}$/.test(input.account) || !nonempty(input.externalId, 200)) throw new Error('invalid_wait');
    } else if (step.tool === 'personal_followup') {
      const input = step.input;
      if (!exactObject(input, ['taskKey', 'title', 'factStepId']) || !nonempty(input.taskKey, 100) || !nonempty(input.title, 300) || !nonempty(input.factStepId, 100) || !ancestors.has(input.factStepId) || seen.get(input.factStepId)?.tool !== 'record_fact') throw new Error('invalid_followup');
    } else throw new Error('unknown_tool');
    seen.set(step.id, { tool: step.tool, ancestors });
  }
}

function validatePolicy(policy: PlannerPolicy) {
  const lists = [policy?.allowedSources, policy?.allowedArtifactKinds];
  if (lists.some(list => !Array.isArray(list) || list.some(value => !nonempty(value, 200)))) throw new Error('invalid_planner_policy');
  if (!Array.isArray(policy.trustedFacts) || policy.trustedFacts.some(f => !exactObject(f, ['source', 'key', 'value', 'observedAt']) || !nonempty(f.source, 200) || !nonempty(f.key, 100) || !nonempty(f.value) || !nonempty(f.observedAt, 50) || !Number.isFinite(Date.parse(f.observedAt)))) throw new Error('invalid_planner_policy');
  const budgets = [policy.maxSteps, policy.maxFactCalls, policy.maxArtifactCalls, policy.maxTextChars, policy.maxPlanVersions, policy.maxPlannerAttempts];
  if (budgets.some(n => !Number.isSafeInteger(n) || n < 0) || policy.maxSteps > 32 || policy.maxPlanVersions < 1) throw new Error('invalid_planner_policy');
}

function validateProposedSteps(steps: unknown, policy: PlannerPolicy) {
  validatePolicy(policy);
  validateSteps(steps);
  let facts = 0, artifacts = 0, waits = 0, followups = 0, textChars = 0;
  for (const step of steps) {
    if (step.tool === 'record_fact') {
      if (!policy.allowedSources.includes(step.input.source)) throw new Error('source_not_authorized');
      if (!policy.trustedFacts.some(f => f.source === step.input.source && f.key === step.input.key && f.value === step.input.value && f.observedAt === step.input.observedAt)) throw new Error('fact_not_verified');
      facts++; textChars += step.input.value.length;
    } else if (step.tool === 'create_artifact') {
      if (!policy.allowedArtifactKinds.includes(step.input.kind)) throw new Error('artifact_not_authorized');
      artifacts++; textChars += step.input.content.length;
    } else if (step.tool === 'wait_for_mock_record') {
      waits++;
    } else {
      followups++; textChars += step.input.title.length;
    }
  }
  if (steps.length > policy.maxSteps || facts > policy.maxFactCalls || artifacts > policy.maxArtifactCalls || waits > 2 || followups > 2 || textChars > policy.maxTextChars) throw new Error('planner_budget_exceeded');
}

export function createWorkflow(db: Db, clock: () => string) {
  const memory = createMemory(db, clock);
  // Business timestamps can be simulated, so manual request deadlines use the
  // host wall clock. Legacy rows without a deadline are deliberately untouched.
  function recoverManualAttempts() {
    const now = Date.now();
    return db.tx(() => {
      const rows = db.all<{ attempt_id: number }>("SELECT d.attempt_id FROM workflow_manual_attempt_deadlines d JOIN workflow_planner_attempts a ON a.id=d.attempt_id WHERE d.deadline_ms<=? AND a.status='running' ORDER BY d.deadline_ms LIMIT 1000", [now]);
      for (const row of rows) {
        if (db.run("UPDATE workflow_planner_attempts SET status='failed' WHERE id=? AND status='running'", [row.attempt_id]).changes) db.run('INSERT INTO workflow_planner_diagnostics(attempt_id,code) VALUES(?,?)', [row.attempt_id, 'planner_deadline_elapsed']);
      }
      return rows.length;
    });
  }
  recoverManualAttempts();
  const recoveryTimer = setInterval(() => { try { recoverManualAttempts(); } catch { console.error('PLANNER_RECOVERY_FAILED'); } }, 2000);
  recoveryTimer.unref();
  function goalMemory(goalId: string): MemoryContext {
    const goal = db.get<{ title: string; owner: string; project: string }>('SELECT g.title,g.owner,p.project FROM workflow_goals g JOIN workflow_goal_projects p ON p.goal_id=g.id WHERE g.id=?', [goalId]);
    return goal ? memory.retrieve(goal.project, goal.owner, goal.title) : { preferences: [], conversation: [] };
  }
  function plannerTasks(goalId: string) {
    return db.all<{ taskKey: string; title: string; status: string }>('SELECT task_key AS taskKey,title,status FROM workflow_personal_tasks WHERE goal_id=? ORDER BY id DESC LIMIT 20', [goalId]);
  }
  function plannerRecords(goalId: string, policy: PlannerPolicy) {
    const project = db.get<{ project: string }>('SELECT project FROM workflow_goal_projects WHERE goal_id=?', [goalId])?.project;
    if (!project) return { records: [], truncated: false };
    const rows = db.all<{ source: string; account: string; externalId: string; revision: number; occurredAt: string; sourceEventId: string }>(`SELECT m.source,m.account,m.external_id AS externalId,m.revision,m.occurred_at AS occurredAt,ev.source_event_id AS sourceEventId FROM mock_connector_events m JOIN events ev ON ev.id=m.event_id
      WHERE m.project=? AND m.operation='upsert' AND m.revision=(SELECT MAX(x.revision) FROM mock_connector_events x WHERE x.project=m.project AND x.source=m.source AND x.account=m.account AND x.external_id=m.external_id)
      ORDER BY m.occurred_at DESC,m.event_id DESC LIMIT 65`, [project]);
    return { records: rows.slice(0, 64).map(row => ({ source: row.source, account: row.account, externalId: row.externalId, revision: row.revision, occurredAt: row.occurredAt, factKey: policy.trustedFacts.find(f => f.source === `${row.source}:${row.sourceEventId}`)?.key ?? null })), truncated: rows.length > 64 };
  }
  function createGoal(goal: { id: string; title: string; owner: string; completion: string }) {
    if (!goal || !nonempty(goal.id, 100) || !nonempty(goal.title, 300) || !nonempty(goal.owner, 100) || !nonempty(goal.completion, 1000)) throw new Error('invalid_goal');
    db.run('INSERT INTO workflow_goals(id,title,owner,completion,created_at) VALUES(?,?,?,?,?)', [goal.id, goal.title, goal.owner, goal.completion, clock()]);
  }
  function savePlan(goalId: string, expectedVersion: number, steps: WorkflowStep[]) {
    validateSteps(steps);
    return db.tx(() => {
      const goal = db.get<{ current_plan: number }>('SELECT current_plan FROM workflow_goals WHERE id=?', [goalId]);
      if (!goal) throw new Error('goal_not_found');
      if (goal.current_plan !== expectedVersion) throw new Error('stale_plan');
      const version = expectedVersion + 1;
      db.run('INSERT INTO workflow_plans(goal_id,version,created_at) VALUES(?,?,?)', [goalId, version, clock()]);
      steps.forEach((step, position) => db.run('INSERT INTO workflow_steps(goal_id,plan_version,position,step_id,tool,input_json,depends_json,status) VALUES(?,?,?,?,?,?,?,?)', [goalId, version, position, step.id, step.tool, j.str(step.input), j.str(step.dependsOn), 'pending']));
      db.run('UPDATE workflow_goals SET current_plan=? WHERE id=?', [version, goalId]);
      return version;
    });
  }
  // Host-only method. No planner input or HTTP endpoint may set this authority.
  function configurePlanner(goalId: string, expectedPolicyVersion: number, policy: PlannerPolicy) {
    validatePolicy(policy);
    return db.tx(() => {
      if (!db.get('SELECT id FROM workflow_goals WHERE id=?', [goalId])) throw new Error('goal_not_found');
      const current = db.get<{ version: number }>('SELECT version FROM workflow_planner_policies WHERE goal_id=? ORDER BY version DESC LIMIT 1', [goalId]);
      if ((current?.version ?? 0) !== expectedPolicyVersion) throw new Error('stale_policy');
      const version = expectedPolicyVersion + 1;
      db.run('INSERT INTO workflow_planner_policies(goal_id,version,policy_json,created_at) VALUES(?,?,?,?)', [goalId, version, j.str(policy), clock()]);
      return version;
    });
  }
  // Project assignment and policy construction are host-only operations.
  function bindProject(goalId: string, project: string) {
    if (!nonempty(project, 200)) throw new Error('invalid_project');
    return db.tx(() => {
      if (!db.get('SELECT id FROM workflow_goals WHERE id=?', [goalId])) throw new Error('goal_not_found');
      const existing = db.get<{ project: string }>('SELECT project FROM workflow_goal_projects WHERE goal_id=?', [goalId]);
      if (existing && existing.project !== project) throw new Error('project_already_bound');
      if (!existing) db.run('INSERT INTO workflow_goal_projects(goal_id,project) VALUES(?,?)', [goalId, project]);
    });
  }
  function evidenceSnapshot(id: number) {
    return db.get<{ id: number; source: string; source_event_id: string; occurred_at: string; project: string; excerpt: string; trusted: number }>(`SELECT e.id,ev.source,ev.source_event_id,ev.occurred_at,ev.project,e.excerpt,e.trusted
      FROM evidence e JOIN events ev ON ev.id=e.event_id WHERE e.id=?`, [id]);
  }
  function configurePlannerFromEvidence(goalId: string, expectedPolicyVersion: number, limits: EvidencePolicy) {
    return db.tx(() => {
      const bound = db.get<{ project: string }>('SELECT project FROM workflow_goal_projects WHERE goal_id=?', [goalId]);
      if (!bound) throw new Error('project_not_bound');
      const rows = db.all<{ id: number }>(`SELECT e.id FROM evidence e JOIN events ev ON ev.id=e.event_id
        WHERE ev.project=? AND e.trusted=1 ORDER BY ev.occurred_at DESC,e.id DESC LIMIT 12`, [bound.project]);
      const snapshots = rows.map(row => evidenceSnapshot(row.id)!);
      const facts = snapshots.map(row => ({ source: `${row.source}:${row.source_event_id}`, key: `evidence:${row.id}`, value: row.excerpt, observedAt: row.occurred_at }));
      const policy: PlannerPolicy = { ...limits, allowedSources: [...new Set(facts.map(f => f.source))], trustedFacts: facts };
      const version = configurePlanner(goalId, expectedPolicyVersion, policy);
      for (const row of snapshots) db.run('INSERT INTO workflow_policy_evidence(goal_id,policy_version,evidence_id,snapshot_json) VALUES(?,?,?,?)', [goalId, version, row.id, j.str(row)]);
      return { version, facts };
    });
  }
  function checkPolicyEvidence(goalId: string, policyVersion: number) {
    const evidence = db.all<{ evidence_id: number; snapshot_json: string }>('SELECT evidence_id,snapshot_json FROM workflow_policy_evidence WHERE goal_id=? AND policy_version=?', [goalId, policyVersion]);
    for (const source of evidence) {
      const snapshot = evidenceSnapshot(source.evidence_id);
      if (!snapshot || snapshot.trusted !== 1 || j.str(snapshot) !== source.snapshot_json) throw new Error('stale_evidence');
    }
  }
  function saveProposedPlan(goalId: string, expectedVersion: number, proposal: unknown) {
    // Reject extra fields so proposals cannot supply or widen their own authority.
    if (!exactObject(proposal, ['steps']) || !Array.isArray(proposal.steps)) throw new Error('invalid_proposal_schema');
    const steps = proposal.steps as WorkflowStep[];
    return db.tx(() => {
      const goal = db.get<{ current_plan: number }>('SELECT current_plan FROM workflow_goals WHERE id=?', [goalId]);
      if (!goal) throw new Error('goal_not_found');
      if (goal.current_plan !== expectedVersion) throw new Error('stale_plan');
      const authority = db.get<{ version: number; policy_json: string }>('SELECT version,policy_json FROM workflow_planner_policies WHERE goal_id=? ORDER BY version DESC LIMIT 1', [goalId]);
      if (!authority) throw new Error('planner_policy_missing');
      const policy = j.parse<PlannerPolicy>(authority.policy_json, null as any);
      checkPolicyEvidence(goalId, authority.version);
      validateProposedSteps(steps, policy);
      if (goal.current_plan >= policy.maxPlanVersions) throw new Error('planner_replan_budget_exceeded');
      const version = savePlan(goalId, expectedVersion, steps);
      db.run('INSERT INTO workflow_plan_authorities(goal_id,plan_version,policy_version) VALUES(?,?,?)', [goalId, version, authority.version]);
      return version;
    });
  }
  async function planWithAdapter(goalId: string, expectedVersion: number, adapter: PlannerAdapter, timeoutMs = 15_000, hooks?: { signal?: AbortSignal; beforeCommit?: () => void; afterCommit?: (version: number) => void; schedulerLease?: { jobId: string; runId: string; leaseToken: string } }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('invalid_planner_timeout');
    const goal = db.get<{ id: string; title: string; completion: string; current_plan: number }>('SELECT id,title,completion,current_plan FROM workflow_goals WHERE id=?', [goalId]);
    if (!goal) throw new Error('goal_not_found');
    if (goal.current_plan !== expectedVersion) throw new Error('stale_plan');
    const authority = db.get<{ version: number; policy_json: string }>('SELECT version,policy_json FROM workflow_planner_policies WHERE goal_id=? ORDER BY version DESC LIMIT 1', [goalId]);
    if (!authority) throw new Error('planner_policy_missing');
    const policy = j.parse<PlannerPolicy>(authority.policy_json, null as any);
    validatePolicy(policy);
    if (goal.current_plan >= policy.maxPlanVersions) throw new Error('planner_replan_budget_exceeded');
    checkPolicyEvidence(goalId, authority.version);
    const memorySnapshot = goalMemory(goalId);
    const taskSnapshot = plannerTasks(goalId);
    const recordSnapshot = plannerRecords(goalId, policy);
    const attemptId = db.tx(() => {
      hooks?.beforeCommit?.();
      const latest = db.get<{ version: number }>('SELECT version FROM workflow_planner_policies WHERE goal_id=? ORDER BY version DESC LIMIT 1', [goalId]);
      const currentGoal = db.get<{ current_plan: number }>('SELECT current_plan FROM workflow_goals WHERE id=?', [goalId]);
      if (!latest || latest.version !== authority.version) throw new Error('stale_policy');
      if (!currentGoal || currentGoal.current_plan !== expectedVersion) throw new Error('stale_plan');
      checkPolicyEvidence(goalId, authority.version);
      const used = db.get<{ n: number }>('SELECT count(*) AS n FROM workflow_planner_attempts WHERE goal_id=?', [goalId])!.n;
      if (used >= policy.maxPlannerAttempts) throw new Error('planner_attempt_budget_exceeded');
      const id = Number(db.run('INSERT INTO workflow_planner_attempts(goal_id,policy_version,status,created_at) VALUES(?,?,?,?)', [goalId, authority.version, 'running', clock()]).lastInsertRowid);
      if (hooks?.schedulerLease) db.run('INSERT INTO workflow_planner_attempt_leases(attempt_id,job_id,run_id,lease_token) VALUES(?,?,?,?)', [id, hooks.schedulerLease.jobId, hooks.schedulerLease.runId, hooks.schedulerLease.leaseToken]);
      else db.run('INSERT INTO workflow_manual_attempt_deadlines(attempt_id,deadline_ms) VALUES(?,?)', [id, Date.now() + timeoutMs]);
      return id;
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    let phase: 'adapter' | 'validation' = 'adapter';
    try {
      if (hooks?.signal?.aborted) throw new PlannerDiagnostic('planner_cancelled');
      const timeout = new Promise<never>((_, reject) => {
        cancel = () => { reject(new PlannerDiagnostic('planner_cancelled')); controller.abort(); };
        hooks?.signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => { reject(new PlannerDiagnostic('planner_timeout')); controller.abort(); }, timeoutMs);
      });
      const proposal = await Promise.race([adapter({ goal: { id: goal.id, title: goal.title, completion: goal.completion }, facts: policy.trustedFacts.map(fact => ({ ...fact })), currentRecords: structuredClone(recordSnapshot), memory: structuredClone(memorySnapshot), personalTasks: structuredClone(taskSnapshot), allowedArtifactKinds: [...policy.allowedArtifactKinds], maxSteps: policy.maxSteps, signal: controller.signal }), timeout]);
      phase = 'validation';
      return db.tx(() => {
        hooks?.beforeCommit?.();
        if (!hooks?.schedulerLease) {
          const deadline = db.get<{ deadline_ms: number }>('SELECT deadline_ms FROM workflow_manual_attempt_deadlines WHERE attempt_id=?', [attemptId]);
          if (!deadline || Date.now() >= deadline.deadline_ms) throw new Error('planner_timeout');
        }
        if (!db.get("SELECT id FROM workflow_planner_attempts WHERE id=? AND status='running'", [attemptId])) throw new Error('planner_attempt_fenced');
        const current = db.get<{ version: number }>('SELECT version FROM workflow_planner_policies WHERE goal_id=? ORDER BY version DESC LIMIT 1', [goalId]);
        if (!current || current.version !== authority.version) throw new Error('stale_policy');
        if (j.str(goalMemory(goalId)) !== j.str(memorySnapshot)) throw new Error('stale_memory');
        if (j.str(plannerTasks(goalId)) !== j.str(taskSnapshot)) throw new Error('stale_personal_task');
        if (j.str(plannerRecords(goalId, policy)) !== j.str(recordSnapshot)) throw new Error('stale_evidence');
        const version = saveProposedPlan(goalId, expectedVersion, proposal);
        db.run('INSERT INTO workflow_plan_memory(goal_id,plan_version,memory_json) VALUES(?,?,?)', [goalId, version, j.str(memorySnapshot)]);
        hooks?.afterCommit?.(version);
        db.run("UPDATE workflow_planner_attempts SET status='succeeded' WHERE id=?", [attemptId]);
        return version;
      });
    } catch (error) {
      const candidate = error instanceof PlannerDiagnostic ? plannerCode(error.code) : phase === 'validation' && error instanceof Error ? plannerCode(error.message) : 'planner_unknown_failure';
      const code = db.tx(() => {
        const changed = db.run("UPDATE workflow_planner_attempts SET status='failed' WHERE id=? AND status='running'", [attemptId]).changes;
        if (changed) {
          db.run('INSERT INTO workflow_planner_diagnostics(attempt_id,code) VALUES(?,?)', [attemptId, candidate]);
          return candidate;
        }
        return plannerCode(db.get<{ code: string }>('SELECT code FROM workflow_planner_diagnostics WHERE attempt_id=?', [attemptId])?.code);
      });
      throw new PlannerAttemptFailure(code, attemptId);
    } finally {
      if (timer) clearTimeout(timer);
      if (cancel) hooks?.signal?.removeEventListener('abort', cancel);
    }
  }
  function runNext(goalId: string, version: number) {
    return db.tx(() => {
      const goal = db.get<{ current_plan: number }>('SELECT current_plan FROM workflow_goals WHERE id=?', [goalId]);
      if (!goal) throw new Error('goal_not_found');
      if (goal.current_plan !== version) throw new Error('stale_plan');
      if (version < 1) throw new Error('plan_not_found');
      const authority = db.get<{ policy_version: number }>('SELECT policy_version FROM workflow_plan_authorities WHERE goal_id=? AND plan_version=?', [goalId, version]);
      if (authority) {
        const current = db.get<{ version: number; policy_json: string }>('SELECT version,policy_json FROM workflow_planner_policies WHERE goal_id=? ORDER BY version DESC LIMIT 1', [goalId]);
        if (!current || current.version !== authority.policy_version) throw new Error('stale_policy');
        checkPolicyEvidence(goalId, current.version);
        const memoryRow = db.get<{ memory_json: string }>('SELECT memory_json FROM workflow_plan_memory WHERE goal_id=? AND plan_version=?', [goalId, version]);
        if (memoryRow && memoryRow.memory_json !== j.str(goalMemory(goalId))) throw new Error('stale_memory');
        const storedSteps = db.all<any>('SELECT step_id,tool,input_json,depends_json FROM workflow_steps WHERE goal_id=? AND plan_version=? ORDER BY position', [goalId, version]);
        const steps = storedSteps.map(row => ({ id: row.step_id, tool: row.tool, input: j.parse<unknown>(row.input_json, null), dependsOn: j.parse<unknown>(row.depends_json, null) }));
        validateProposedSteps(steps, j.parse<PlannerPolicy>(current.policy_json, null as any));
      }
      const allSteps = db.all<any>('SELECT * FROM workflow_steps WHERE goal_id=? AND plan_version=? ORDER BY position', [goalId, version]);
      const unfinished = allSteps.filter(row => row.status === 'pending' || row.status === 'waiting');
      if (!unfinished.length) return { status: 'complete' as const };
      const complete = new Set(allSteps.filter(row => row.status === 'complete').map(row => row.step_id));
      let step: any;
      let waiting: { status: 'waiting'; stepId: string; reason: { source: string; account: string; externalId: string } } | undefined;
      for (const candidate of unfinished) {
        if (!j.parse<string[]>(candidate.depends_json, []).every(dep => complete.has(dep))) continue;
        if (candidate.tool === 'wait_for_mock_record') {
          const input = j.parse<any>(candidate.input_json, {});
          const bound = db.get<{ project: string }>('SELECT project FROM workflow_goal_projects WHERE goal_id=?', [goalId]);
          if (!bound) throw new Error('project_not_bound');
          const found = db.get<{ event_id: number }>(`SELECT m.event_id FROM mock_connector_events m WHERE m.project=? AND m.source=? AND m.account=? AND m.external_id=? AND m.operation='upsert' AND m.revision=(SELECT MAX(x.revision) FROM mock_connector_events x WHERE x.source=m.source AND x.account=m.account AND x.project=m.project AND x.external_id=m.external_id)`, [bound.project, input.source, input.account, input.externalId]);
          if (!found) {
            const reason = { source: input.source, account: input.account, externalId: input.externalId };
            if (candidate.status !== 'waiting') db.run("UPDATE workflow_steps SET status='waiting',result_json=? WHERE goal_id=? AND plan_version=? AND step_id=?", [j.str(reason), goalId, version, candidate.step_id]);
            waiting ??= { status: 'waiting', stepId: candidate.step_id, reason };
            continue;
          }
        }
        step = candidate;
        break;
      }
      if (!step) {
        if (waiting) return waiting;
        throw new Error('dependency_incomplete');
      }
      const input = j.parse<any>(step.input_json, {});
      let result: { id: number; alreadyCompleted?: boolean };
      if (step.tool === 'record_fact') {
        const row = db.run('INSERT INTO workflow_facts(goal_id,fact_key,value,source,observed_at,plan_version,step_id) VALUES(?,?,?,?,?,?,?)', [goalId, input.key, input.value, input.source, input.observedAt, version, step.step_id]);
        result = { id: Number(row.lastInsertRowid) };
      } else if (step.tool === 'create_artifact') {
        const fact = db.get<{ id: number }>('SELECT id FROM workflow_facts WHERE goal_id=? AND plan_version=? AND step_id=?', [goalId, version, input.factStepId]);
        if (!fact) throw new Error('fact_not_found');
        const row = db.run('INSERT INTO workflow_artifacts(goal_id,kind,content,source_fact_id,plan_version,step_id,created_at) VALUES(?,?,?,?,?,?,?)', [goalId, input.kind, input.content, fact.id, version, step.step_id, clock()]);
        result = { id: Number(row.lastInsertRowid) };
      } else if (step.tool === 'wait_for_mock_record') {
        const bound = db.get<{ project: string }>('SELECT project FROM workflow_goal_projects WHERE goal_id=?', [goalId]);
        if (!bound) throw new Error('project_not_bound');
        const found = db.get<{ event_id: number }>(`SELECT m.event_id FROM mock_connector_events m WHERE m.project=? AND m.source=? AND m.account=? AND m.external_id=? AND m.operation='upsert' AND m.revision=(SELECT MAX(x.revision) FROM mock_connector_events x WHERE x.source=m.source AND x.account=m.account AND x.project=m.project AND x.external_id=m.external_id)`, [bound.project, input.source, input.account, input.externalId]);
        if (!found) {
          const reason = { source: input.source, account: input.account, externalId: input.externalId };
          db.run("UPDATE workflow_steps SET status='waiting',result_json=? WHERE goal_id=? AND plan_version=? AND step_id=?", [j.str(reason), goalId, version, step.step_id]);
          return { status: 'waiting' as const, stepId: step.step_id, reason };
        }
        result = { id: found.event_id };
      } else if (step.tool === 'personal_followup') {
        const fact = db.get<{ id: number }>('SELECT id FROM workflow_facts WHERE goal_id=? AND plan_version=? AND step_id=?', [goalId, version, input.factStepId]);
        if (!fact) throw new Error('fact_not_found');
        const existing = db.get<{ id: number; status: string; title: string }>('SELECT id,status,title FROM workflow_personal_tasks WHERE goal_id=? AND task_key=?', [goalId, input.taskKey]);
        if (existing && existing.status !== 'open' && existing.status !== 'done') throw new Error('invalid_personal_task_status');
        if (existing?.status === 'done') {
          if (existing.title !== input.title) throw new Error('completed_personal_task_conflict');
          result = { id: existing.id, alreadyCompleted: true };
          db.run("UPDATE workflow_steps SET status='complete',result_json=? WHERE goal_id=? AND plan_version=? AND step_id=?", [j.str(result), goalId, version, step.step_id]);
          return { status: 'progressed' as const, stepId: step.step_id, result };
        }
        const changed = db.run("INSERT INTO workflow_personal_tasks(goal_id,task_key,title,status,source_fact_id,plan_version,updated_at) VALUES(?,?,?,'open',?,?,?) ON CONFLICT(goal_id,task_key) DO UPDATE SET title=excluded.title,source_fact_id=excluded.source_fact_id,plan_version=excluded.plan_version,updated_at=excluded.updated_at WHERE workflow_personal_tasks.status='open'", [goalId, input.taskKey, input.title, fact.id, version, clock()]);
        if (changed.changes !== 1) throw new Error('personal_task_changed');
        result = { id: db.get<{ id: number }>('SELECT id FROM workflow_personal_tasks WHERE goal_id=? AND task_key=?', [goalId, input.taskKey])!.id };
      } else throw new Error('unknown_tool');
      db.run("UPDATE workflow_steps SET status='complete',result_json=? WHERE goal_id=? AND plan_version=? AND step_id=?", [j.str(result), goalId, version, step.step_id]);
      return { status: 'progressed' as const, stepId: step.step_id, result };
    });
  }
  function completePersonalTask(goalId: string, taskId: unknown, expectedPlanVersion: unknown) {
    if (!Number.isSafeInteger(taskId) || Number(taskId) < 1 || !Number.isSafeInteger(expectedPlanVersion) || Number(expectedPlanVersion) < 1) throw new Error('invalid_personal_task');
    return db.tx(() => {
      const task = db.get<{ id: number; status: string; plan_version: number }>('SELECT id,status,plan_version FROM workflow_personal_tasks WHERE id=? AND goal_id=?', [Number(taskId), goalId]);
      if (!task) throw new Error('personal_task_not_found');
      if (task.plan_version !== expectedPlanVersion) throw new Error('stale_personal_task');
      if (task.status === 'done') return { status: 'already_completed' as const };
      if (task.status !== 'open') throw new Error('invalid_personal_task_status');
      const changed = db.run("UPDATE workflow_personal_tasks SET status='done',updated_at=? WHERE id=? AND goal_id=? AND status='open' AND plan_version=?", [clock(), task.id, goalId, task.plan_version]);
      if (changed.changes !== 1) throw new Error('stale_personal_task');
      db.run('INSERT INTO workflow_personal_task_completions(task_id,goal_id,plan_version,actor,completed_at) VALUES(?,?,?,?,?)', [task.id, goalId, task.plan_version, 'local', clock()]);
      return { status: 'completed' as const };
    });
  }
  function inspect(goalId: string) {
    return {
      goal: db.get('SELECT * FROM workflow_goals WHERE id=?', [goalId]),
      plans: db.all('SELECT * FROM workflow_plans WHERE goal_id=? ORDER BY version', [goalId]),
      plannerAttempts: db.all<{ id: number; status: string; created_at: string; code: string | null }>('SELECT a.id,a.status,a.created_at,d.code FROM workflow_planner_attempts a LEFT JOIN workflow_planner_diagnostics d ON d.attempt_id=a.id WHERE a.goal_id=? ORDER BY a.id DESC LIMIT 24', [goalId]).map(row => ({ id: row.id, status: row.status, createdAt: row.created_at, code: row.code === null ? null : plannerCode(row.code) })),
      planMemory: db.all<{ plan_version: number; memory_json: string }>('SELECT plan_version,memory_json FROM workflow_plan_memory WHERE goal_id=? ORDER BY plan_version', [goalId]).map(row => ({ planVersion: row.plan_version, memory: j.parse(row.memory_json, {}) })),
      steps: db.all('SELECT * FROM workflow_steps WHERE goal_id=? ORDER BY plan_version,position', [goalId]),
      facts: db.all('SELECT * FROM workflow_facts WHERE goal_id=? ORDER BY id', [goalId]),
      personalTasks: db.all('SELECT * FROM workflow_personal_tasks WHERE goal_id=? ORDER BY id', [goalId]),
      artifacts: db.all('SELECT * FROM workflow_artifacts WHERE goal_id=? ORDER BY id', [goalId])
    };
  }
  return { createGoal, savePlan, configurePlanner, bindProject, configurePlannerFromEvidence, saveProposedPlan, planWithAdapter, runNext, completePersonalTask, inspect, close: () => clearInterval(recoveryTimer) };
}
