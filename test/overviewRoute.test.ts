import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundSchedulerEnabled, buildServer } from '../src/server.js';
import { DISCORD_BUSINESS_SCOPE } from '../src/discordScope.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('overview route exposes actual state with honest unobserved runtime status', async () => {
  const token = 'test-only-bridge-token-xxxxxxxxxxxxxxxx';
  const app = buildServer({ dbPath: ':memory:', discordBridge: { token, ...DISCORD_BUSINESS_SCOPE } });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/overview' });
    assert.equal(response.statusCode, 200);
    const overview = response.json();
    assert.equal(overview.version, 1);
    assert.equal(overview.runtime.engine, 'offline');
    assert.equal(overview.runtime.discord.configured, true);
    assert.equal(overview.runtime.discord.state, 'unobserved');
    assert.equal(overview.runtime.scheduler, 'disabled');
    assert.ok(!response.body.includes(token));
  } finally { await app.close(); }
});

test('scheduler startup setting supports explicit pause and rejects ambiguous values', () => {
  assert.equal(backgroundSchedulerEnabled(undefined), true);
  assert.equal(backgroundSchedulerEnabled('1'), true);
  assert.equal(backgroundSchedulerEnabled('0'), false);
  assert.throws(() => backgroundSchedulerEnabled('false'), /invalid_scheduler_setting/);
});

test('actual app entry starts with scheduler paused on an isolated port and database', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'paused-app-'));
  const child = spawn(process.execPath, ['--experimental-sqlite', '--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env: { ...process.env, HOST: '127.0.0.1', PORT: '0', WORK_ASSISTANT_DB: join(dir, 'isolated.sqlite'), WORK_ASSISTANT_ENGINE: 'offline', WORK_ASSISTANT_SCHEDULER_ENABLED: '0', WORK_ASSISTANT_DISCORD_BRIDGE_TOKEN: '', OPENAI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    const address = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('startup_timeout')), 20_000);
      child.stdout.on('data', chunk => { output += String(chunk); const match = /work-assistant mock on (http:\/\/127\.0\.0\.1:\d+)/.exec(output); if (match) { clearTimeout(timeout); resolve(match[1]); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`unexpected_exit_${code}`)); });
    });
    const overview = await (await fetch(`${address}/api/overview`, { signal: AbortSignal.timeout(5000) })).json() as any;
    assert.equal(overview.runtime.scheduler, 'disabled');
    assert.equal(overview.runtime.engine, 'offline');
  } finally {
    if (child.exitCode === null) { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
