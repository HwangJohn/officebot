import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import { createService, type AnalystAdapterFactory, type Decision, type Engine, type LiveAdapterFactory } from './core.js';
import { requireOpenAIKey } from './openaiAdapter.js';
import { DISCORD_BUSINESS_SCOPE, hasDiscordScope } from './discordScope.js';
import { buildSystemOverview } from './systemOverview.js';
import type { PlannerAdapter } from './workflow.js';
import { PlannerAttemptFailure } from './plannerDiagnostics.js';

function sanitize(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e ?? 'request_failed');
  if (msg === 'bad_goal') return '분석 목표를 1자 이상 1000자 이하로 입력해 주세요.';
  if (msg === 'analysis_context_changed') return '업무 맥락이 분석 중 변경되었습니다. 최신 상태를 다시 불러온 뒤 다시 시도해 주세요.';
  return msg.includes('OPENAI_API_KEY') ? msg : '요청 처리 실패';
}
const safeWorkspaceErrors: Record<string, { status: number; message: string }> = {
  stale_plan: { status: 409, message: '계획이 변경되었습니다. 최신 상태를 확인해 주세요.' },
  stale_memory: { status: 409, message: '대화나 선호가 변경되었습니다. 다시 계획해 주세요.' },
  stale_policy: { status: 409, message: '계획 조건이 변경되었습니다. 다시 계획해 주세요.' },
  stale_evidence: { status: 409, message: '근거가 변경되었습니다. 다시 계획해 주세요.' },
  stale_source: { status: 409, message: '검토 기준 파일이 변경되었습니다. 다시 확인해 주세요.' },
  stale_improvement: { status: 409, message: '개선안이 변경되었습니다. 다시 확인해 주세요.' },
  stale_target: { status: 409, message: '목업 대상이 변경되었습니다. 다시 확인해 주세요.' },
  stale_message: { status: 409, message: '대화가 변경되었습니다. 최신 내용을 확인해 주세요.' },
  stale_preference: { status: 409, message: '선호가 변경되었습니다. 최신 내용을 확인해 주세요.' },
  stale_personal_task: { status: 409, message: '개인 작업이 변경되었습니다. 최신 내용을 확인해 주세요.' },
  stale_schedule: { status: 409, message: '점검 일정이 변경되었습니다. 최신 상태를 확인해 주세요.' },
  completed_personal_task_conflict: { status: 409, message: '완료된 개인 작업과 다른 작업입니다. 계획을 다시 만들어 주세요.' },
  mock_revision_conflict: { status: 409, message: '같은 버전에 다른 목업 내용이 있습니다.' },
  needs_evidence: { status: 422, message: '현재 프로젝트에 신뢰할 수 있는 근거가 필요합니다.' },
  improvement_no_review_evidence: { status: 422, message: '차단되거나 지연된 근거가 있는 저장된 점검이 필요합니다.' },
  invalid_mock_target: { status: 422, message: '이 목표의 유효한 목업 대상을 선택해 주세요.' },
  invalid_quiet_hours: { status: 422, message: '시간대와 시작·종료 시각을 확인해 주세요.' },
  invalid_civil_schedule: { status: 422, message: '점검 시간대와 시각을 확인해 주세요.' },
  discord_bridge_unavailable: { status: 409, message: 'Discord 업무 연결이 설정되지 않았습니다.' }
};
function allowedOrigin(origin: string | undefined, host: string | undefined) {
  if (!origin) return true;
  if (origin === 'null' || !host) return false;
  try {
    const u = new URL(origin);
    const expectedHost = host.toLowerCase();
    return ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1', 'localhost'].includes(u.hostname) && u.host.toLowerCase() === expectedHost;
  } catch { return false; }
}

export type DiscordBridgeConfig = { token: string; ownerId: string; guildId: string; channelId: string };
export function backgroundSchedulerEnabled(value: string | undefined) {
  if (value === undefined || value === '1') return true;
  if (value === '0') return false;
  throw new Error('invalid_scheduler_setting');
}
function validDiscordBridge(value: DiscordBridgeConfig | undefined): value is DiscordBridgeConfig {
  return hasDiscordScope() && !!value && typeof value.token === 'string' && value.token.length >= 32 && value.ownerId === DISCORD_BUSINESS_SCOPE.ownerId && value.guildId === DISCORD_BUSINESS_SCOPE.guildId && value.channelId === DISCORD_BUSINESS_SCOPE.channelId;
}
function equalToken(candidate: unknown, expected: string) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(opts: { dbPath: string; engine?: Engine; clock?: string; liveAdapterFactory?: LiveAdapterFactory; analystAdapterFactory?: AnalystAdapterFactory; plannerAdapterFactory?: () => PlannerAdapter; plannerTimeoutMs?: number; handlerTimeoutMs?: number; discordBridge?: DiscordBridgeConfig; schedulerClock?: () => number; backgroundScheduler?: boolean; clientDistRoot?: string }) {
  if (opts.engine === 'openai' && !opts.liveAdapterFactory) requireOpenAIKey();
  const app = Fastify({ logger: false });
  const bridge = validDiscordBridge(opts.discordBridge) ? opts.discordBridge : undefined;
  const svc = createService({ ...opts, discordOwnerId: bridge?.ownerId });
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distRoot = opts.clientDistRoot ?? join(root, 'dist', 'client');
  const fallbackIndexPath = join(root, 'client', 'index.html');
  app.register(fastifyStatic, { root: join(distRoot, 'assets'), prefix: '/assets/', decorateReply: false });
  let runningTick: Promise<unknown> | undefined;
  function tickScheduler() {
    if (!runningTick) runningTick = svc.automation.tick().finally(() => { runningTick = undefined; });
    return runningTick;
  }
  const timer = opts.backgroundScheduler ? setInterval(() => { void tickScheduler().catch(() => console.error('SCHEDULER_TICK_FAILED')); }, 15_000) : undefined;
  timer?.unref();
  app.addHook('onClose', async () => { if (timer) clearInterval(timer); if (runningTick) await runningTick.catch(() => {}); svc.close(); });
  app.addHook('preHandler', async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !allowedOrigin(req.headers.origin, req.headers.host)) {
      reply.code(403); throw new Error('bad_origin');
    }
  });
  app.setErrorHandler((err: Error, req, reply) => {
    if (err.message === 'bad_origin') return reply.code(403).send({ error: '허용되지 않은 Origin입니다.' });
    const isWorkspace = /^\/api\/(?:goals|preferences|project-messages|messages\/\d+\/correction|mock-events)(?:[/?]|$)/.test(req.url);
    if (isWorkspace && err instanceof PlannerAttemptFailure) return reply.code(422).send({ error: '계획을 저장하지 못했습니다. 진단 코드를 확인해 주세요.', code: err.code, attemptId: err.attemptId });
    const safe = isWorkspace ? safeWorkspaceErrors[err.message] : undefined;
    if (safe) return reply.code(safe.status).send({ error: safe.message, code: err.message });
    return reply.code(400).send({ error: sanitize(err) });
  });
  app.get('/', async (_req, reply) => {
    const builtIndexPath = join(distRoot, 'index.html');
    try { return reply.type('text/html; charset=utf-8').send(await readFile(builtIndexPath, 'utf8')); }
    catch { return reply.type('text/html; charset=utf-8').send(await readFile(fallbackIndexPath, 'utf8')); }
  });
  app.get('/api/state', async () => svc.state());
  app.get('/api/overview', async () => buildSystemOverview(svc.db, { engine: opts.engine ?? 'offline', backgroundScheduler: Boolean(opts.backgroundScheduler), discordConfigured: Boolean(bridge) }));
  app.get('/api/messages', async () => svc.messages());
  app.post('/api/messages', async (req: any) => svc.addMessage(req.body ?? {}));
  app.post('/api/messages/:id/correction', async (req: any) => svc.memory.correctMessage(Number(req.params.id), req.body?.expectedVersion, req.body?.content));
  app.get('/api/project-messages', async (req: any) => svc.memory.scopedMessages(String(req.query?.project ?? ''), 'local'));
  app.post('/api/project-messages/:sourceId/correction', async (req: any) => svc.memory.correctScoped(String(req.params.sourceId), req.body?.project, 'local', req.body?.expectedVersion, req.body?.content));
  app.get('/api/preferences', async (req: any) => svc.memory.preferences(String(req.query?.project ?? 'proposal-alpha'), 'local'));
  app.post('/api/preferences', async (req: any) => svc.memory.setPreference(req.body?.project, 'local', req.body?.key, req.body?.value, req.body?.expectedVersion));
  app.get('/api/goals', async () => svc.workspaceGoals());
  app.get('/api/projects', async () => svc.workspaceProjects());
  app.post('/api/goals', async (req: any) => svc.createWorkspaceGoal(req.body ?? {}));
  app.get('/api/goals/:id', async (req: any) => svc.inspectWorkspaceGoal(String(req.params.id)));
  app.get('/api/goals/:id/targets', async (req: any) => svc.workspaceApprovals.targets(String(req.params.id)));
  app.get('/api/goals/:id/notifications', async (req: any) => svc.notifications.inspect(String(req.params.id)));
  app.post('/api/goals/:id/notifications', async (req: any) => svc.notifications.configure(String(req.params.id), req.body?.enabled));
  app.post('/api/goals/:id/notifications/quiet-hours', async (req: any) => svc.notifications.configureQuietHours(String(req.params.id), req.body?.quietHours));
  app.get('/api/goals/:id/improvements/context', async (req: any) => svc.workspaceImprovements.context(String(req.params.id)));
  app.get('/api/goals/:id/improvements', async (req: any) => svc.workspaceImprovements.list(String(req.params.id)));
  app.post('/api/goals/:id/improvements', async (req: any) => svc.workspaceImprovements.create(String(req.params.id), req.body));
  app.post('/api/goals/:id/improvements/propose', async (req: any) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) throw new Error('invalid_improvement_proposal_request');
    return svc.workspaceImprovements.propose(String(req.params.id));
  });
  app.post('/api/goals/:id/improvements/:improvementId/review', async (req: any) => svc.workspaceImprovements.review(String(req.params.id), String(req.params.improvementId)));
  app.post('/api/goals/:id/plan', async (req: any) => svc.planWorkspaceGoal(String(req.params.id), req.body?.expectedVersion));
  app.post('/api/goals/:id/step', async (req: any) => svc.runWorkspaceGoal(String(req.params.id), req.body?.version));
  app.post('/api/goals/:id/personal-tasks/:taskId/complete', async (req: any) => svc.completeWorkspacePersonalTask(String(req.params.id), Number(req.params.taskId), req.body?.expectedPlanVersion));
  app.post('/api/goals/:id/schedules', async (req: any) => svc.automation.scheduleReview(String(req.params.id), req.body?.kind, req.body?.firstDueAt, req.body?.civil, req.body?.expectedScheduleId));
  app.post('/api/goals/:id/schedules/:kind/cancel', async (req: any) => ({ cancelled: svc.automation.cancelReview(String(req.params.id), String(req.params.kind), req.body?.expectedScheduleId) }));
  app.post('/api/scheduler/tick', async () => tickScheduler());
  app.post('/api/goals/:id/approvals', async (req: any) => svc.workspaceApprovals.create(String(req.params.id), req.body?.artifactId, req.body?.targetEventId));
  app.post('/api/goals/:id/approvals/:approvalId/decide', async (req: any) => svc.workspaceApprovals.decide(String(req.params.id), String(req.params.approvalId), req.body?.decision, { kind: 'local', id: 'local' }, req.body?.text));
  app.post('/api/discord/business', async (req: any, reply) => {
    if (!bridge || !equalToken(req.headers['x-work-assistant-discord-bridge'], bridge.token) || req.body?.guildId !== bridge.guildId || req.body?.channelId !== bridge.channelId || req.body?.authorId !== bridge.ownerId) return reply.code(403).send({ error: '권한이 없습니다.' });
    const action = req.body?.action;
    if (action === 'notification_claim') return { notification: svc.notifications.claim() };
    if (action === 'notification_lookup') return svc.notifications.lookupHeld(String(req.body?.notificationId ?? ''));
    if (action === 'notification_reconcile') return svc.notifications.reconcile(String(req.body?.notificationId ?? ''), String(req.body?.commandMessageId ?? ''), req.body?.receipt);
    if (action === 'notification_finish') {
      const result = req.body?.status === 'sent' ? { status: 'sent' as const, messageId: String(req.body?.messageId ?? '') } : req.body?.status === 'unknown' ? { status: 'unknown' as const } : null;
      if (!result) throw new Error('invalid_notification_result');
      return svc.notifications.finish(String(req.body?.notificationId ?? ''), String(req.body?.claimToken ?? ''), result);
    }
    if (action === 'goals') return { goals: svc.workspaceGoals() };
    if (action === 'context') return svc.discordWorkspaceContext();
    if (action === 'projects') return { projects: svc.workspaceProjects() };
    if (action === 'create_goal' || action === 'remember') {
      try {
        return action === 'create_goal' ? svc.discordCreateGoal(req.body?.messageId, { project: req.body?.project, title: req.body?.title, completion: req.body?.completion }) : svc.discordRemember(req.body?.messageId, req.body?.project, req.body?.content);
      } catch (error) {
        if (error instanceof Error && error.message === 'unknown_project') return { status: 'needs_project', projects: svc.workspaceProjects() };
        throw error;
      }
    }
    if (action === 'plan_goal') return svc.discordPlanGoal(req.body?.messageId, String(req.body?.goalId ?? ''));
    if (action === 'step_goal') return svc.discordStepGoal(req.body?.messageId, String(req.body?.goalId ?? ''));
    if (action === 'approvals') return { approvals: svc.workspaceApprovals.inspect(String(req.body?.goalId ?? '')) };
    if (action === 'approve' || action === 'reject' || action === 'defer' || action === 'resume') return svc.workspaceApprovals.decide(String(req.body?.goalId ?? ''), String(req.body?.approvalId ?? ''), action, { kind: 'discord', id: bridge.ownerId });
    throw new Error('invalid_business_command');
  });
  app.post('/api/mock-events', async (req: any) => svc.mockConnectors.ingest(req.body));
  app.get('/api/mock-events', async (req: any) => svc.mockConnectors.query(req.query?.project, req.query?.source, req.query?.account));
  app.get('/api/artifacts', async () => svc.artifacts());
  app.get('/api/assets/architecture-overview.svg', async (_req, reply) => reply.type('image/svg+xml; charset=utf-8').send(await readFile(join(root, 'public', 'architecture-overview.svg'), 'utf8')));
  app.post('/api/analyze', async (req: any) => svc.analyzeGoal(req.body?.goalText));
  app.post('/api/fixtures/:index', async (req: any) => svc.ingestFixture(Number(req.params.index)));
  app.post('/api/ingest-all', async () => svc.ingestAll());
  app.post('/api/step', async () => svc.advanceGoal('api'));
  app.post('/api/clock/advance', async (req: any) => svc.advanceClock(req.body?.kind === 'week' ? 'week' : 'day'));
  app.post('/api/approvals/:id/decide', async (req: any) => svc.decide(String(req.params.id), String(req.body?.decision) as Decision, req.body?.edit));
  app.get('/api/approvals/:id/reconciliation', async (req: any) => svc.inspectMockReconciliation(String(req.params.id)));
  app.post('/api/approvals/:id/recovery', async (req: any) => svc.recoverMockProcessing(String(req.params.id), req.body?.recoveryToken));
  app.post('/api/approvals/:id/reconciliation', async (req: any) => svc.reconcileMockApproval(String(req.params.id), req.body?.reviewToken));
  return app;
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  const port = Number(process.env.PORT ?? 4317);
  const host = process.env.HOST ?? '127.0.0.1';
  const engine = ((process.env.WORK_ASSISTANT_ENGINE === 'openai' || process.argv.includes('--openai')) ? 'openai' : 'offline') as Engine;
  const dbPath = process.env.WORK_ASSISTANT_DB ?? 'data/work-assistant.sqlite';
  const discordBridge = { token: process.env.WORK_ASSISTANT_DISCORD_BRIDGE_TOKEN ?? '', ownerId: process.env.WORK_ASSISTANT_DISCORD_OWNER_ID ?? '', guildId: process.env.WORK_ASSISTANT_DISCORD_GUILD_ID ?? '', channelId: process.env.WORK_ASSISTANT_DISCORD_CHANNEL_ID ?? '' };
  const app = buildServer({ dbPath, engine, discordBridge, backgroundScheduler: backgroundSchedulerEnabled(process.env.WORK_ASSISTANT_SCHEDULER_ENABLED) });
  const close = async () => { try { await app.close(); } finally { process.exit(0); } };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  app.listen({ host, port }).then(address => console.log(`work-assistant mock on ${address} (${engine}${engine === 'openai' ? ': real SDK HITL' : ''})`)).catch((err: unknown) => { const msg = err instanceof Error ? err.message : String(err); console.error(engine === 'openai' ? 'OpenAI mode failed; check process-only OPENAI_API_KEY.' : 'Server failed.', msg); process.exit(1); });
}
