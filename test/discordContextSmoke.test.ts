import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runDiscordContextSmoke } from '../scripts/discord-context-smoke.js';

test('isolated contextual smoke converts prior turns and reports only bounded results', async () => {
  const converter = createRequire(import.meta.url)('../node_modules/@openai/agents-openai/dist/openaiResponsesConverter.js');
  let calls = 0;
  const result = await runDiscordContextSmoke(async items => { calls++; const wire = converter.getInputItems(items); assert.equal(wire[1].role, 'assistant'); return 'The synthetic quote is missing.'; });
  assert.deepEqual(result, { ok: true, sends: 1, turns: 4, failures: [] });
  assert.equal(calls, 1);
  const failed = await runDiscordContextSmoke(async () => { throw new Error('private-fake-error'); });
  assert.deepEqual(failed, { ok: false, sends: 1, turns: 2, failures: ['model'] });
  assert.doesNotMatch(JSON.stringify(failed), /private-fake-error/);
});
