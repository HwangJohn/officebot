// Diagnostic values are fixed by the host; never persist or return model/SDK text.
export const PLANNER_CODES = [
  'planner_unknown_failure', 'planner_adapter_failed', 'planner_sensitive_input',
  'planner_timeout', 'planner_cancelled', 'planner_attempt_fenced', 'planner_deadline_elapsed',
  'invalid_proposal_schema', 'invalid_plan_size', 'invalid_step_schema', 'invalid_step_dependencies',
  'invalid_fact', 'invalid_artifact', 'invalid_wait', 'invalid_followup', 'unknown_tool',
  'invalid_artifact_unknown_fact_step', 'invalid_artifact_future_fact_step', 'invalid_artifact_non_fact_step',
  'invalid_followup_unknown_fact_step', 'invalid_followup_future_fact_step', 'invalid_followup_non_fact_step',
  'source_not_authorized', 'fact_not_verified', 'artifact_not_authorized', 'planner_budget_exceeded',
  'planner_replan_budget_exceeded', 'stale_plan', 'stale_policy', 'stale_evidence', 'stale_memory', 'stale_personal_task'
] as const;
export type PlannerCode = typeof PLANNER_CODES[number];
const codes = new Set<string>(PLANNER_CODES);
export function plannerCode(value: unknown): PlannerCode {
  return typeof value === 'string' && codes.has(value) ? value as PlannerCode : 'planner_unknown_failure';
}
// Only host-produced typed adapter errors are treated as specific adapter diagnostics.
export class PlannerDiagnostic extends Error {
  readonly code: PlannerCode;
  constructor(code: PlannerCode) { super(code); this.code = code; }
}
export class PlannerAttemptFailure extends PlannerDiagnostic {
  constructor(code: PlannerCode, readonly attemptId: number) { super(code); }
}
