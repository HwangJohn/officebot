import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentInputItem } from '@openai/agents';
import { createClaimStore, createDiscordChat, createOpenAIAnswer } from '../src/discordChat.js';
import { requireOpenAIKey } from '../src/openaiAdapter.js';

// One model call, synthetic local state and a fake sender; no Discord or company service.
export async function runDiscordContextSmoke(runModel?: (items: AgentInputItem[]) => Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'discord-context-smoke-'));
  const store = createClaimStore(join(dir, 'isolated.sqlite'));
  try {
    const message = { id: 'synthetic-new', guildId: 'synthetic-guild', channelId: 'synthetic-channel', userId: 'synthetic-owner', bot: false, webhook: false, mentioned: false, text: 'What is the proposal waiting for?', origin: 'gateway' as const };
    store.save({ ...message, id: 'synthetic-old' }, 'Hello', 'Hello, how can I help?');
    const context = { totalGoals: 2, goals: [
      { id: 'synthetic-proposal', title: 'SYNTHETIC proposal', project: 'SYNTHETIC-proposal', current_plan: 1, steps: [{ tool: 'wait_for_mock_record', status: 'waiting' }], artifacts: [{ kind: 'draft', content: 'SYNTHETIC local draft' }], sources: [{ source: 'outlook', excerpt: 'Vendor quote is missing.' }] },
      { id: 'synthetic-weekly', title: 'SYNTHETIC weekly review', project: 'SYNTHETIC-weekly', current_plan: 1, steps: [{ tool: 'record_fact', status: 'complete' }], artifacts: [], sources: [{ source: 'jira', excerpt: 'ISSUE-7 needs review.' }] }
    ] };
    const failures: string[] = []; let sends = 0;
    const answer = createOpenAIAnswer(runModel ? 'synthetic-key' : requireOpenAIKey(), async () => context, [], runModel);
    const handle = createDiscordChat({ guildId: message.guildId, channelId: message.channelId, claim: id => store.claim(id), history: store, answer, onFailureStage: stage => { failures.push(stage); }, send: async () => { sends++; } });
    await handle(message);
    const turns = store.load(message);
    return { ok: failures.length === 0 && sends === 1 && turns.length === 4, sends, turns: turns.length, failures };
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDiscordContextSmoke().then(result => { console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; }).catch(() => { console.error('DISCORD_CONTEXT_SMOKE_FAILED'); process.exitCode = 1; });
}
