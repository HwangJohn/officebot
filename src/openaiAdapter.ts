import { Agent, OpenAIProvider, Runner, RunState, setTracingDisabled, tool } from '@openai/agents';
import { z } from 'zod';

export type LiveAdapter = {
  prepare(approvalId: string): Promise<{ snapshot: string; meta?: Record<string, unknown> }>;
  decide(approvalId: string, snapshot: string, approve: boolean): Promise<{ snapshot: string; meta?: Record<string, unknown> }>;
};

type ApprovalLookup = (id: string) => any;
type Commit = (id: string) => unknown;

export function requireOpenAIKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required only when WORK_ASSISTANT_ENGINE=openai. Offline mode does not need a key.');
  return apiKey;
}

function makeMeta(result: any) {
  const interruptions = result?.interruptions?.length ?? 0;
  return {
    interruptions,
    final: interruptions === 0 ? Boolean(result?.finalOutput) : false,
    responses: Array.isArray(result?.rawResponses) ? result.rawResponses.map((r: any) => ({ responseId: r?.responseId, usage: r?.usage })).filter((r: any) => r.responseId || r.usage) : [],
    model: 'gpt-5.4-nano'
  };
}

function parseArgs(args: unknown): any {
  if (typeof args === 'string') { try { return JSON.parse(args); } catch { return {}; } }
  return args && typeof args === 'object' ? args : {};
}

export function createAgentsLiveAdapter(opts: { commitApprovedAction: Commit; getApproval: ApprovalLookup }): LiveAdapter {
  setTracingDisabled(process.env.OPENAI_AGENTS_TRACING !== '1');
  const executeMockAction = tool({
    name: 'execute_mock_action',
    description: 'Execute exactly one server-owned mock external action after human approval. The approvalId is supplied by the server workflow.',
    parameters: z.object({ approvalId: z.string() }),
    needsApproval: true,
    execute: async ({ approvalId }) => {
      const a = opts.getApproval(approvalId);
      if (!a) throw new Error('approval_not_found');
      const committed = opts.commitApprovedAction(approvalId);
      return JSON.stringify({ committed, approvalId });
    }
  });
  const agent = new Agent({
    name: 'Local work assistant HITL executor',
    model: 'gpt-5.4-nano',
    modelSettings: { reasoning: { effort: 'low' }, maxTokens: 256 } as any,
    instructions: 'Call execute_mock_action once with the exact approvalId provided by the user. Do not invent recipients, targets, or payloads. All business data is synthetic.',
    tools: [executeMockAction]
  });
  const provider = new (OpenAIProvider as any)({ apiKey: requireOpenAIKey(), baseURL: 'https://api.openai.com/v1', useResponses: true });
  const runner: any = new (Runner as any)({ modelProvider: provider });
  const runWithRunner = async (input: any) => runner.run(agent, input, { maxTurns: 3 });

  return {
    async prepare(approvalId: string) {
      const result = await runWithRunner(`Prepare the approved-interruption for server-owned approvalId ${JSON.stringify(approvalId)}. Call execute_mock_action with exactly that approvalId and wait for approval.`);
      if (!result?.state || (result.interruptions?.length ?? 0) < 1) throw new Error('sdk_prepare_no_interruption');
      return { snapshot: result.state.toString(), meta: makeMeta(result) };
    },
    async decide(approvalId: string, snapshot: string, approve: boolean) {
      const state: any = await RunState.fromString(agent, snapshot);
      const interruptions: any[] = typeof state.getInterruptions === 'function' ? state.getInterruptions() : [];
      let matched = 0;
      for (const interruption of interruptions) {
        const args = parseArgs(interruption.arguments);
        const isExact = interruption.name === 'execute_mock_action' && args.approvalId === approvalId;
        if (isExact && approve) { matched++; state.approve(interruption); }
        else { if (isExact) matched++; state.reject(interruption); }
      }
      if (matched !== 1) throw new Error('sdk_interruption_mismatch');
      const result = await runWithRunner(state);
      return { snapshot: result.state?.toString?.() ?? snapshot, meta: makeMeta(result) };
    }
  };
}
