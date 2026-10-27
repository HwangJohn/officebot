import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catchUp, startupCatchUp, startupCatchUpEnabled, createClaimStore, createDiscordChat, createOpenAIAnswer, createChatDiagnostics, classifyChatFailure, emptyModelCategory, splitDiscord, loadWorkContext, messageContentEnabled, replyOptions, sanitizeDiscordText, toIncoming, type DiscordSource } from '../src/discordChat.js';
import { verifyDiscordIdentity } from '../src/discordScope.js';

const event = (id: string, overrides: Partial<Parameters<ReturnType<typeof createDiscordChat>>[0]> = {}) => ({ id, guildId: 'guild', channelId: 'channel', userId: 'one', bot: false, webhook: false, mentioned: true, text: '안녕', origin: 'gateway' as const, ...overrides });
test('plain messages are scoped, bots and webhooks are ignored, and claims persist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-test-')); const path = join(dir, 'seen.sqlite');
  const store = createClaimStore(path); let answers = 0; const sent: string[] = [];
  const make = (claim: (id: string) => boolean) => createDiscordChat({ guildId: 'guild', channelId: 'channel', claim, answer: async () => { answers++; return '안녕하세요'; }, send: async text => { sent.push(text); } });
  const handle = make(id => store.claim(id));
  for (const m of [event('x1', { guildId: 'other' }), event('x2', { channelId: 'other' }), event('x3', { bot: true }), event('x4', { webhook: true }), event('x5', { text: '' })]) await handle(m);
  await handle(event('10', { mentioned: false })); await handle(event('10')); assert.equal(answers, 1); assert.deepEqual(sent, ['안녕하세요']);
  store.close(); const again = createClaimStore(path); await make(id => again.claim(id))(event('10')); assert.equal(answers, 1); again.close(); rmSync(dir, { recursive: true, force: true });
});
test('mention fallback is explicit and capability flags select the input mode', async () => {
  assert.equal(messageContentEnabled(0), false); assert.equal(messageContentEnabled(1 << 18), true); assert.equal(messageContentEnabled(1 << 19), true);
  let answers = 0;
  const handle = createDiscordChat({ guildId: 'guild', channelId: 'channel', requireMention: true, claim: () => true, answer: async () => { answers++; return '답'; }, send: async () => {} });
  await handle(event('1', { mentioned: false })); await handle(event('2')); assert.equal(answers, 1);
});
test('bounded recent catch-up is chronological, shares claims with gateway and survives restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-catchup-')); const path = join(dir, 'seen.sqlite');
  let store = createClaimStore(path); const answers: string[] = []; const sent: string[] = []; const origins: string[] = [];
  const make = () => createDiscordChat({ guildId: 'guild', channelId: 'channel', claim: id => store.claim(id), onProcessing: m => { origins.push(`${m.id}:${m.origin}`); }, answer: async input => { answers.push(input); return '답'; }, send: async (_text, message) => { sent.push(message.id); } });
  const now = 10_000_000; const source = (id: number, timestamp: number, overrides: Partial<DiscordSource> = {}): DiscordSource => ({ id: String(id), guildId: 'guild', channelId: 'channel', author: { id: 'one', bot: false }, webhookId: null, content: String(id), createdTimestamp: timestamp, mentions: { users: { has: () => false } }, ...overrides });
  const messages = Array.from({ length: 22 }, (_, i) => source(i + 1, now - (22 - i) * 1000));
  messages.push(source(23, now - 3600001), source(24, now - 500, { author: { id: 'bot', bot: true } }), source(25, now - 400, { webhookId: 'hook' }), source(26, now - 300, { channelId: 'other' }));
  const handle = make();
  // A real gateway event overlaps the fetched set while processing is in flight.
  const live = handle(toIncoming(messages[10], 'bot', 'gateway'));
  await Promise.all([live, catchUp(messages, 'bot', handle, now)]);
  assert.deepEqual(answers, ['11', ...Array.from({ length: 17 }, (_, i) => String(i + 6)).filter(id => id !== '11')]);
  assert.equal(new Set(sent).size, sent.length); assert.ok(origins.includes('11:gateway')); assert.ok(origins.includes('6:catchup')); assert.ok(!origins.some(x => /^(1|23|24|25|26):/.test(x)));
  store.close(); store = createClaimStore(path); await catchUp(messages, 'bot', make(), now); await catchUp([source(23, now - 3600001)], 'bot', make(), now); assert.equal(answers.length, 17); store.close(); rmSync(dir, { recursive: true, force: true });
});
test('disabled startup catch-up neither fetches nor dispatches old messages', async () => {
  assert.equal(startupCatchUpEnabled(undefined), false);
  assert.equal(startupCatchUpEnabled('0'), false);
  assert.equal(startupCatchUpEnabled('true'), false);
  assert.equal(startupCatchUpEnabled('1'), true);
  let fetched = 0, handled = 0;
  const fetchMessages = async () => { fetched++; return [{ id: '1', guildId: 'guild', channelId: 'channel', author: { id: 'one', bot: false }, webhookId: null, content: 'old', createdTimestamp: Date.now(), mentions: { users: { has: () => false } } }]; };
  assert.equal(await startupCatchUp(false, fetchMessages, 'bot', async () => { handled++; }), 'disabled');
  assert.equal(fetched, 0); assert.equal(handled, 0);
  assert.equal(await startupCatchUp(true, fetchMessages, 'bot', async () => { handled++; }), 'complete');
  assert.equal(fetched, 1); assert.equal(handled, 1);
});
test('replies reference the actual input and cannot ping', () => {
  assert.deepEqual(replyOptions('답', '100000000000000006'), { content: '답', reply: { messageReference: '100000000000000006', failIfNotExists: true }, allowedMentions: { parse: [], repliedUser: false } });
});
test('follow-up context is bounded and isolated per user and serialized', async () => {
  const seen = new Set<string>(); const histories: string[][] = [];
  const handle = createDiscordChat({ guildId: 'guild', channelId: 'channel', claim: id => !seen.has(id) && !!seen.add(id), answer: async (input, history) => { histories.push(history.map(x => x.content)); await new Promise(r => setTimeout(r, 2)); return `답:${input}`; }, send: async () => {} });
  await Promise.all([handle(event('1', { text: '첫 질문' })), handle(event('2', { text: '이어서' }))]);
  assert.deepEqual(histories[1], ['첫 질문', '답:첫 질문']);
  await handle(event('3', { userId: 'two' })); assert.deepEqual(histories[2], []);
  for (let i = 4; i < 15; i++) await handle(event(String(i))); assert.ok(histories.at(-1)!.length <= 10);
});
test('Discord conversation is restored after restart and isolated by user and channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-history-')); const path = join(dir, 'seen.sqlite');
  let store = createClaimStore(path); const histories: string[][] = [];
  const make = () => createDiscordChat({ guildId: 'guild', channelId: 'channel', claim: id => store.claim(id), history: store, secrets: ['private-token'], answer: async (input, history) => { histories.push(history.map(turn => turn.content)); return `답:${input}`; }, send: async () => {} });
  try {
    await make()(event('1', { text: '첫 질문 private-token' }));
    await make()(event('2', { userId: 'two', text: '다른 사람' }));
    store.close(); store = createClaimStore(path);
    await make()(event('3', { text: '이어서' }));
    assert.deepEqual(histories[2], ['첫 질문 [비밀 값 삭제]', '답:첫 질문 [비밀 값 삭제]']);
    assert.deepEqual(store.load(event('4', { channelId: 'other' })), []);
    assert.deepEqual(store.load(event('5', { guildId: 'other' })), []);
    assert.deepEqual(store.load(event('6', { userId: 'two' })).map(turn => turn.content), ['다른 사람', '답:다른 사람']);
    assert.equal(store.claim('1'), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('errors are generic and secrets and mentions are removed', async () => {
  const sent: string[] = []; let n = 0;
  const handle = createDiscordChat({ guildId: 'guild', channelId: 'channel', claim: () => true, secrets: ['SECRET-EXAMPLE'], answer: async () => { if (++n === 1) throw new Error('SECRET-EXAMPLE'); return 'SECRET-EXAMPLE @everyone <@123>'; }, send: async text => { sent.push(text); } });
  await handle(event('1')); await handle(event('2'));
  assert.match(sent[0], /다시 질문/); assert.ok(sent.every(x => !x.includes('SECRET-EXAMPLE') && !x.includes('@everyone') && !x.includes('<@123>')));
  const generic = sanitizeDiscordText('sk-proj-' + 'a'.repeat(22) + ' ' + 'b'.repeat(23) + '.' + 'C'.repeat(6) + '.' + 'd'.repeat(26));
  assert.equal(generic, '[비밀 값 삭제] [비밀 값 삭제]');
});
test('failure diagnostics identify bounded stages without exposing thrown values', async () => {
  const marker = 'private-injected-error'; const stages: string[] = []; const replies: string[] = [];
  const diagnose = async (mode: string) => {
    const answer = createOpenAIAnswer('fake-key', async () => {
      if (mode === 'context') throw new Error(marker);
      return mode === 'guard' ? { value: marker } : { value: 'synthetic context' };
    }, [marker], async () => { if (mode === 'model') throw new Error(marker); return 'answer'; });
    const handle = createDiscordChat({ guildId: 'guild', channelId: 'channel', claim: () => true,
      history: { load: () => { if (mode === 'history') throw new Error(marker); return []; }, save: () => { if (mode === 'save') throw new Error(marker); } },
      answer, onFailureStage: stage => { stages.push(stage); },
      send: async text => { if (mode === 'send' && text === 'answer') throw new Error(marker); replies.push(text); } });
    await handle(event(mode));
  };
  for (const mode of ['history', 'context', 'guard', 'model', 'send', 'save']) await diagnose(mode);
  assert.deepEqual(stages, ['history', 'context', 'guard', 'model', 'send', 'save']);
  assert.ok(replies.every(text => !text.includes(marker)));
});
test('health diagnostics expose fixed categories without retaining exception data', async () => {
  const diagnostic = createChatDiagnostics(); const replies: string[] = [];
  const marker = 'private-injected-error';
  const answer = createOpenAIAnswer('fake-key', async () => null, [], async () => { throw { status: 429, message: marker }; });
  const handle = createDiscordChat({ guildId: 'guild', channelId: 'channel', claim: () => true, answer, onFailureStage: diagnostic.record, send: async text => { replies.push(text); } });
  assert.equal(diagnostic.snapshot(), null);
  await handle(event('diagnostic'));
  const snapshot = diagnostic.snapshot()!;
  assert.equal(snapshot.stage, 'model'); assert.equal(snapshot.category, 'rate_limit');
  assert.ok(Number.isFinite(Date.parse(snapshot.observedAt)));
  assert.doesNotMatch(JSON.stringify(snapshot), /private-injected-error|429/);
  assert.ok(replies.every(reply => !reply.includes(marker)));
  snapshot.stage = 'history'; assert.equal(diagnostic.snapshot()?.stage, 'model');
  assert.equal(classifyChatFailure({ status: 401 }), 'auth');
  assert.equal(classifyChatFailure({ status: 503 }), 'http');
  assert.equal(classifyChatFailure({ cause: { code: 'ECONNRESET' } }), 'network');
  assert.equal(classifyChatFailure({ name: 'TimeoutError' }), 'timeout');
  assert.equal(classifyChatFailure({ name: 'ModelBehaviorError', message: 'OpenAI Responses request ended with unsuccessful terminal state "response.incomplete".' }), 'incomplete');
  assert.equal(classifyChatFailure({ name: 'ModelBehaviorError', message: marker }), 'unknown');
  assert.equal(classifyChatFailure({ message: marker }), 'unknown');
  assert.equal(emptyModelCategory([{ output: [], providerData: { status: 'incomplete', text: marker } }]), 'incomplete');
  assert.equal(emptyModelCategory([{ output: [{ status: 'incomplete' }] }]), 'incomplete');
  assert.equal(emptyModelCategory([{ output: [] }]), 'empty');
  const empty = createOpenAIAnswer('fake-key', async () => null, [], async () => '');
  const emptyHandle = createDiscordChat({ guildId: 'guild', channelId: 'channel', claim: () => true, answer: empty, onFailureStage: diagnostic.record, send: async () => {} });
  await emptyHandle(event('empty')); assert.equal(diagnostic.snapshot()?.category, 'empty');
});
test('populated chat uses one bounded model request with restored history and handles incomplete output', async () => {
  let calls = 0;
  const answer = createOpenAIAnswer('fake-key', async () => ({ goals: [{ description: 'synthetic context '.repeat(400) }] }), [], async (items, agent) => {
    calls++;
    assert.equal(agent.model, 'gpt-5.4-nano');
    assert.equal(agent.modelSettings.maxTokens, 2048);
    assert.equal(agent.modelSettings.reasoning?.effort, 'low');
    assert.equal(items.length, 3);
    assert.ok(JSON.stringify(items).includes('synthetic context'));
    throw { name: 'ModelBehaviorError', message: 'OpenAI Responses request ended with unsuccessful terminal state "response.incomplete".' };
  });
  const diagnostics = createChatDiagnostics(); const replies: string[] = [];
  const handle = createDiscordChat({ guildId: 'guild', channelId: 'channel', claim: () => true, answer,
    history: { load: () => [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'prior answer' }], save: () => { throw new Error('must not save an incomplete answer'); } },
    onFailureStage: diagnostics.record, send: async text => { replies.push(text); } });
  await handle(event('incomplete'));
  assert.equal(calls, 1);
  assert.equal(diagnostics.snapshot()?.category, 'incomplete');
  assert.equal(replies.length, 1);
  assert.ok(!replies[0].includes('ModelBehaviorError'));
});
test('send failure is not replayed; user receives a generic retry notice', async () => {
  const ids = new Set<string>(); const sent: string[] = []; let calls = 0;
  const handle = createDiscordChat({ guildId: 'guild', channelId: 'channel', claim: id => !ids.has(id) && !!ids.add(id), answer: async () => '답', send: async text => { if (++calls === 1) throw { status: 429, message: 'secret' }; sent.push(text); } });
  await handle(event('1')); await handle(event('1')); assert.equal(calls, 2); assert.match(sent[0], /다시 질문/); assert.doesNotMatch(sent[0], /secret|429/);
});
test('long Unicode output stays below Discord limits', () => {
  const parts = splitDiscord('😀'.repeat(3000)); assert.ok(parts.length > 1); assert.ok(parts.every(x => x.length <= 2000)); assert.equal(parts.join(''), '😀'.repeat(3000));
});
test('workspace HTTP is read-only and keeps trusted evidence while excluding approval payloads', async () => {
  const requests: string[] = [];
  const fake: typeof fetch = async (url, init) => { requests.push(`${init?.method} ${url}`); return new Response(JSON.stringify({ goal: { project: 'proposal-alpha' }, events: [{ source_event_id: 'own', project: 'proposal-alpha' }, { source_event_id: 'other', project: 'separate-beta' }, { source_event_id: 'untrusted', project: 'proposal-alpha' }], evidence: [{ id: 'ev-1', sourceEventId: 'own', source: 'mock', trusted: 1 }, { id: 'ev-2', sourceEventId: 'untrusted', trusted: 0 }, { id: 'ev-other', sourceEventId: 'other', trusted: 1, excerpt: 'other project secret' }, { id: 'ev-orphan', sourceEventId: 'missing', trusted: 1 }], approvals: [{ id: 'a', status: 'pending', payload: { target: 'private' } }], outcomes: [{ effect: 'irrelevant' }] }), { status: 200 }); };
  const context = await loadWorkContext('http://127.0.0.1:4317/api/state', fake);
  assert.deepEqual(requests, ['GET http://127.0.0.1:4317/api/state']);
  assert.deepEqual(context.evidence.map((e: any) => e.id), ['ev-1']);
  assert.deepEqual(context.approvals, [{ id: 'a', status: 'pending', action_type: undefined }]);
  assert.equal('outcomes' in context, false);
});
test('Discord context excludes an analysis that used private local conversation or preferences', async () => {
  const fake: typeof fetch = async () => new Response(JSON.stringify({ goal: { project: 'proposal-alpha' }, events: [], evidence: [], latestAnalysis: { output: { text: 'private local detail' }, memorySources: { conversation: [{ content: 'private local detail' }], preferences: [] } } }), { status: 200 });
  const context = await loadWorkContext('http://127.0.0.1:4317/api/state', fake);
  assert.equal(context.latestAnalysis, false);
  assert.doesNotMatch(JSON.stringify(context), /private local detail/);
});
test('startup verifies bot identity and the explicitly configured channel without network', async () => {
  const record = { ownerId: '100000000000000901', guildId: '100000000000000902', channelId: '100000000000000903', botId: '100000000000000904' };
  let channelGuild = record.guildId, bot = record.botId;
  const get = async (path: string) => path === '/users/@me' ? { id: bot, bot: true } : path === '/applications/@me' ? { id: record.botId, flags: 0 } : { id: record.channelId, guild_id: channelGuild, type: 0 };
  assert.equal(await verifyDiscordIdentity(record, get), 0);
  channelGuild = '100000000000000905';
  await assert.rejects(verifyDiscordIdentity(record, get), /channel_scope_mismatch/);
  channelGuild = record.guildId; bot = '100000000000000905';
  await assert.rejects(verifyDiscordIdentity(record, get), /identity_mismatch/);
  await assert.rejects(verifyDiscordIdentity({ ...record, ownerId: '' }, get), /scope_missing/);
});
