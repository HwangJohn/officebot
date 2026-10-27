import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/core.js';
import { DISCORD_BUSINESS_SCOPE } from '../src/discordScope.js';
import { createNotificationPump } from '../src/discordNotificationTransport.js';
import { buildServer } from '../src/server.js';
import { NOTIFICATION_BATCH_LIMIT, NOTIFICATION_SCAN_LIMIT, nextOutsideQuietHours } from '../src/discordNotifications.js';
import { DISCORD_BUSINESS_BOT_ID } from '../src/discordScope.js';

const source = { account: 'mock:primary', project: 'notifications', externalId: 'thread', revision: 1, occurredAt: '2026-10-27T09:00:00Z', operation: 'upsert' as const, source: 'outlook' as const, details: { subject: 'Request', body: 'Please review.' } };
async function ready(service: ReturnType<typeof createService>) {
  const event = service.mockConnectors.ingest(source);
  const goal = service.createWorkspaceGoal({ title: 'Review', completion: 'Draft', project: source.project });
  await service.planWorkspaceGoal(goal.id, 0);
  service.runWorkspaceGoal(goal.id, 1); service.runWorkspaceGoal(goal.id, 1);
  return { goalId: goal.id, artifactId: service.inspectWorkspaceGoal(goal.id).artifacts[0].id, eventId: event.eventId };
}

test('opt-in creates only new approval notifications, deduplicates, holds uncertainty and persists receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notification-test-')), dbPath = join(dir, 'test.sqlite');
  let time = 1000;
  let service = createService({ dbPath, discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
  try {
    const g = await ready(service);
    const old = service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId);
    assert.equal(service.notifications.inspect(g.goalId).notifications.length, 0);
    service.notifications.configure(g.goalId, true);
    assert.equal(service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId).id, old.id);
    assert.equal(service.notifications.claim(), null);
    const revised = service.workspaceApprovals.decide(g.goalId, old.id, 'edit', { kind: 'local', id: 'local' }, 'First revised draft');
    const claim = service.notifications.claim()!;
    assert.equal(claim.approvalId, revised.newApprovalId);
    assert.match(claim.content, /\[목업 업무\] 승인 검토: Review/);
    assert.ok(claim.content.includes(g.goalId) && claim.content.includes(claim.id) && claim.content.includes(claim.approvalId));
    assert.deepEqual(claim.scope, DISCORD_BUSINESS_SCOPE);
    assert.throws(() => service.notifications.finish(claim.id, 'wrong', { status: 'sent', messageId: '100000000000000010' }), /notification_claim_expired/);
    service.close();
    time += 60_001;
    service = createService({ dbPath, discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.inspect(g.goalId).notifications[0].status, 'held');
    assert.throws(() => service.notifications.finish(claim.id, claim.token, { status: 'sent', messageId: '100000000000000010' }), /notification_claim_expired/);
    const another = service.workspaceApprovals.decide(g.goalId, revised.newApprovalId!, 'edit', { kind: 'local', id: 'local' }, 'Second revised draft');
    const delivered = service.notifications.claim()!;
    assert.equal(delivered.approvalId, another.newApprovalId);
    assert.throws(() => service.notifications.finish(delivered.id, delivered.token, { status: 'sent', messageId: 'bad' }), /invalid_discord_receipt/);
    assert.equal(service.notifications.finish(delivered.id, delivered.token, { status: 'sent', messageId: '100000000000000010' }).status, 'sent');
    service.close(); service = createService({ dbPath, discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.inspect(g.goalId).notifications.find(n => n.id === delivered.id)?.discord_message_id, '100000000000000010');
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('notification titles are bounded and neutralize mentions and detected secrets', async () => {
  const service = createService({ dbPath: ':memory:', discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId });
  try {
    const g = await ready(service);
    service.db.run('UPDATE workflow_goals SET title=? WHERE id=?', ['@everyone <@100000000000000010> sk-abcdefghijklmnop\n' + 'x'.repeat(120), g.goalId]);
    service.notifications.configure(g.goalId, true);
    service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId);
    const claim = service.notifications.claim()!;
    assert.ok(claim.content.startsWith('[목업 업무] 승인 검토:'));
    assert.ok(!claim.content.includes('@everyone') && !claim.content.includes('<@100000000000000010>') && !claim.content.includes('sk-abcdefghijklmnop'));
    assert.ok(Array.from(claim.content.split('\n')[0].slice('[목업 업무] 승인 검토: '.length)).length <= 80);
  } finally { service.close(); }
});

test('bounded same-goal batch preserves every ID and holds an unknown send until exact reconciliation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notification-batch-')), dbPath = join(dir, 'test.sqlite');
  let time = Date.parse('2026-10-27T09:00:00Z');
  let service = createService({ dbPath, discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
  try {
    const events = Array.from({ length: 7 }, (_, i) => service.mockConnectors.ingest({ ...source, externalId: `thread-${i}` }));
    const goal = service.createWorkspaceGoal({ title: 'Batch review', completion: 'Draft', project: source.project });
    await service.planWorkspaceGoal(goal.id, 0); service.runWorkspaceGoal(goal.id, 1); service.runWorkspaceGoal(goal.id, 1);
    const artifact = service.inspectWorkspaceGoal(goal.id).artifacts[0] as any;
    service.notifications.configure(goal.id, true);
    const approvals = events.map(event => service.workspaceApprovals.create(goal.id, artifact.id, event.eventId));
    const first = service.notifications.claim()!;
    const claimedRows = service.notifications.inspect(goal.id).notifications.filter(row => row.status === 'sending');
    assert.equal(claimedRows.length, NOTIFICATION_BATCH_LIMIT);
    for (const row of claimedRows) assert.ok(first.content.includes(row.id) && first.content.includes(row.approval_id));
    assert.ok(first.content.length <= 1800);
    assert.throws(() => service.notifications.finish(first.id, 'wrong', { status: 'unknown' }), /notification_claim_expired/);
    assert.equal(service.notifications.finish(first.id, first.token, { status: 'unknown' }).status, 'held');
    const second = service.notifications.claim()!;
    assert.equal(service.notifications.inspect(goal.id).notifications.filter(row => row.status === 'sending').length, 2);
    assert.equal(service.notifications.finish(second.id, second.token, { status: 'sent', messageId: '100000000000000010' }).status, 'sent');
    service.close(); service = createService({ dbPath, discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
    assert.equal(service.notifications.claim(), null);
    const heldId = claimedRows[1].id;
    const expected = service.notifications.lookupHeld(heldId);
    assert.equal(expected.content, first.content);
    const receipt = { id: '100000000000000010', channel_id: DISCORD_BUSINESS_SCOPE.channelId, author: { id: DISCORD_BUSINESS_BOT_ID, bot: true }, content: first.content, timestamp: new Date(time).toISOString() };
    assert.throws(() => service.notifications.reconcile(heldId, '100000000000000008', { ...receipt, content: 'forged' }), /invalid_notification_receipt/);
    assert.throws(() => service.notifications.reconcile(heldId, '100000000000000008', receipt), /discord_receipt_reused/);
    receipt.id = '100000000000000018';
    assert.equal(service.notifications.reconcile(heldId, '100000000000000008', receipt).status, 'sent');
    assert.equal(service.notifications.lookupHeld(claimedRows[0].id).status, 'sent');
    assert.equal(service.notifications.inspect(goal.id).notifications.filter(row => row.status === 'sent').length, approvals.length);
    assert.equal(service.notifications.inspect(goal.id).notifications.find(row => row.id === heldId)?.discord_message_id, receipt.id);
    assert.equal(service.notifications.reconcile(claimedRows[0].id, '100000000000000011', receipt).status, 'sent');
    assert.equal(service.db.get<any>('SELECT count(*) AS n FROM discord_notification_batch_reconciliation').n, 1);
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('expired batch leases hold every member without resending and stale approvals are excluded', async () => {
  let time = 1000;
  const service = createService({ dbPath: ':memory:', discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
  try {
    const events = Array.from({ length: 3 }, (_, i) => service.mockConnectors.ingest({ ...source, externalId: `target-${i}` }));
    const goal = service.createWorkspaceGoal({ title: 'Batch', completion: 'Draft', project: source.project });
    await service.planWorkspaceGoal(goal.id, 0); service.runWorkspaceGoal(goal.id, 1); service.runWorkspaceGoal(goal.id, 1);
    const artifact = service.inspectWorkspaceGoal(goal.id).artifacts[0] as any;
    service.notifications.configure(goal.id, true);
    const approvals = events.map(event => service.workspaceApprovals.create(goal.id, artifact.id, event.eventId));
    service.workspaceApprovals.decide(goal.id, approvals[2].id, 'reject', { kind: 'local', id: 'local' });
    const claim = service.notifications.claim()!;
    assert.ok(!claim.content.includes(approvals[2].id));
    time += 60_001;
    assert.equal(service.notifications.claim(), null);
    const rows = service.notifications.inspect(goal.id).notifications;
    assert.equal(rows.filter(row => row.status === 'held').length, 2);
    assert.equal(rows.filter(row => row.status === 'cancelled').length, 1);
    assert.throws(() => service.notifications.finish(claim.id, claim.token, { status: 'sent', messageId: '100000000000000010' }), /notification_claim_expired/);
    assert.equal(service.notifications.claim(), null);
  } finally { service.close(); }
});

test('disabled bridge and disabled or stale approvals cannot send queued notices', async () => {
  const service = createService({ dbPath: ':memory:' });
  try {
    const g = await ready(service);
    assert.throws(() => service.notifications.configure(g.goalId, true), /discord_bridge_unavailable/);
  } finally { service.close(); }
  const enabled = createService({ dbPath: ':memory:', discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId });
  try {
    const g = await ready(enabled);
    enabled.notifications.configure(g.goalId, true);
    const a = enabled.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId);
    enabled.workspaceApprovals.decide(g.goalId, a.id, 'reject', { kind: 'local', id: 'local' });
    assert.equal(enabled.notifications.claim(), null);
    assert.equal(enabled.notifications.inspect(g.goalId).notifications[0].status, 'cancelled');
    const b = enabled.workspaceApprovals.decide(g.goalId, a.id, 'edit', { kind: 'local', id: 'local' }, 'New');
    assert.equal(b.status, 'rejected');
    enabled.notifications.configure(g.goalId, false);
    assert.equal(enabled.notifications.claim(), null);
  } finally { enabled.close(); }
});

test('outbox insert is atomic with approval and disabling cancels known-unsent work', async () => {
  const service = createService({ dbPath: ':memory:', discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId });
  try {
    const g = await ready(service);
    service.notifications.configure(g.goalId, true);
    service.db.db.exec("CREATE TRIGGER fail_notification BEFORE INSERT ON discord_notification_outbox BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    assert.throws(() => service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId), /injected failure/);
    assert.equal(service.workspaceApprovals.inspect(g.goalId).length, 0);
    service.db.db.exec('DROP TRIGGER fail_notification');
    service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId);
    assert.equal(service.notifications.inspect(g.goalId).notifications[0].status, 'queued');
    service.notifications.configure(g.goalId, false);
    service.notifications.configure(g.goalId, true);
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.inspect(g.goalId).notifications[0].status, 'cancelled');
  } finally { service.close(); }
});

test('exact approval validation prevents a stale or tampered queued notification', async () => {
  const service = createService({ dbPath: ':memory:', discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId });
  try {
    const g = await ready(service);
    service.notifications.configure(g.goalId, true);
    const a = service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId);
    service.db.run('UPDATE workspace_approvals SET payload_json=? WHERE id=?', ['{}', a.id]);
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.inspect(g.goalId).notifications[0].status, 'cancelled');
  } finally { service.close(); }
});

test('each poll bounds stale queue and expired lease recovery work', async () => {
  let time = 1000;
  const service = createService({ dbPath: ':memory:', discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
  try {
    const g = await ready(service);
    service.notifications.configure(g.goalId, true);
    let id = service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId).id;
    for (let i = 0; i < NOTIFICATION_SCAN_LIMIT + 2; i++) id = service.workspaceApprovals.decide(g.goalId, id, 'edit', { kind: 'local', id: 'local' }, `Draft ${i}`).newApprovalId!;
    service.workspaceApprovals.decide(g.goalId, id, 'reject', { kind: 'local', id: 'local' });
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.inspect(g.goalId).notifications.filter(n => n.status === 'cancelled').length, NOTIFICATION_SCAN_LIMIT);
    assert.equal(service.notifications.inspect(g.goalId).notifications.filter(n => n.status === 'queued').length, 3);
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.inspect(g.goalId).notifications.filter(n => n.status === 'queued').length, 0);
    const rows = service.notifications.inspect(g.goalId).notifications;
    for (const row of rows) service.db.run("UPDATE discord_notification_outbox SET status='sending',lease_until=?,claim_token=? WHERE id=?", [time, 'test-token', row.id]);
    time++;
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.inspect(g.goalId).notifications.filter(n => n.status === 'held').length, NOTIFICATION_SCAN_LIMIT);
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.inspect(g.goalId).notifications.filter(n => n.status === 'held').length, NOTIFICATION_SCAN_LIMIT + 3);
  } finally { service.close(); }
});

test('pump delivers one scoped receipt and holds an uncertain send without retry', async () => {
  const service = createService({ dbPath: ':memory:', discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId });
  let sends = 0;
  try {
    const g = await ready(service);
    service.notifications.configure(g.goalId, true);
    const approval = service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId);
    const bridge = async (body: Record<string, any>) => body.action === 'notification_claim' ? { notification: service.notifications.claim() } : service.notifications.finish(body.notificationId, body.claimToken, body.status === 'sent' ? { status: 'sent', messageId: body.messageId } : { status: 'unknown' });
    const pump = createNotificationPump(bridge, async () => { sends++; return { id: '100000000000000010', channelId: DISCORD_BUSINESS_SCOPE.channelId, authorId: 'bot' }; }, 'bot');
    await pump(); await pump();
    assert.equal(sends, 1);
    assert.equal(service.notifications.inspect(g.goalId).notifications[0].status, 'sent');
    service.workspaceApprovals.decide(g.goalId, approval.id, 'edit', { kind: 'local', id: 'local' }, 'Edited');
    const uncertain = createNotificationPump(bridge, async () => { sends++; throw new Error('connection lost after send'); }, 'bot');
    await uncertain(); await uncertain();
    assert.equal(sends, 2);
    assert.equal(service.notifications.inspect(g.goalId).notifications.find(n => n.status === 'held')?.status, 'held');
  } finally { service.close(); }
});

test('notification bridge rejects unauthenticated claims', async () => {
  const token = 'test-only-bridge-token-xxxxxxxxxxxxxxxx';
  const app = buildServer({ dbPath: ':memory:', discordBridge: { token, ...DISCORD_BUSINESS_SCOPE } });
  try {
    const body = { action: 'notification_claim', authorId: DISCORD_BUSINESS_SCOPE.ownerId, guildId: DISCORD_BUSINESS_SCOPE.guildId, channelId: DISCORD_BUSINESS_SCOPE.channelId };
    assert.equal((await app.inject({ method: 'POST', url: '/api/discord/business', payload: body })).statusCode, 403);
    const ok = await app.inject({ method: 'POST', url: '/api/discord/business', headers: { 'x-work-assistant-discord-bridge': token }, payload: body });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().notification, null);
  } finally { await app.close(); }
});

test('explicit quiet hours respect daylight transitions and isolate goals across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notification-quiet-')), dbPath = join(dir, 'test.sqlite');
  let time = Date.parse('2026-03-08T06:30:00Z');
  let service = createService({ dbPath, discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
  try {
    const quiet = await ready(service), other = await ready(service);
    service.notifications.configure(quiet.goalId, true); service.notifications.configure(other.goalId, true);
    assert.throws(() => service.notifications.configureQuietHours(quiet.goalId, { timeZone: 'Not/AZone', startMinute: 1320, endMinute: 420 }), /invalid_quiet_hours/);
    assert.throws(() => service.notifications.configureQuietHours(quiet.goalId, { timeZone: 'UTC', startMinute: 42, endMinute: 42 }), /invalid_quiet_hours/);
    service.notifications.configureQuietHours(quiet.goalId, { timeZone: 'America/New_York', startMinute: 1320, endMinute: 420 });
    service.workspaceApprovals.create(quiet.goalId, quiet.artifactId, quiet.eventId);
    service.workspaceApprovals.create(other.goalId, other.artifactId, other.eventId);
    const first = service.notifications.claim()!;
    assert.equal(first.goalId, other.goalId);
    service.notifications.finish(first.id, first.token, { status: 'sent', messageId: '100000000000000010' });
    assert.equal(service.notifications.claim(), null);
    const deferred = service.notifications.inspect(quiet.goalId).notifications[0];
    assert.equal(deferred.next_check_at, Date.parse('2026-03-08T11:00:00Z')); // 07:00 after spring-forward
    service.close(); service = createService({ dbPath, discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
    time = deferred.next_check_at! - 1;
    assert.equal(service.notifications.claim(), null);
    time++;
    assert.equal(service.notifications.claim()?.goalId, quiet.goalId);
    assert.equal(nextOutsideQuietHours(Date.parse('2026-11-01T06:30:00Z'), { time_zone: 'America/New_York', start_minute: 1320, end_minute: 420 }), Date.parse('2026-11-01T12:00:00Z')); // 07:00 after fall-back
  } finally { service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('changing or disabling quiet hours clears only queued deferrals', async () => {
  let time = Date.parse('2026-10-27T23:00:00Z');
  const service = createService({ dbPath: ':memory:', discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
  try {
    const g = await ready(service);
    service.notifications.configure(g.goalId, true);
    service.notifications.configureQuietHours(g.goalId, { timeZone: 'UTC', startMinute: 1320, endMinute: 420 });
    service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId);
    assert.equal(service.notifications.claim(), null);
    assert.ok(service.notifications.inspect(g.goalId).notifications[0].next_check_at);
    service.notifications.configureQuietHours(g.goalId, null);
    assert.equal(service.notifications.inspect(g.goalId).notifications[0].next_check_at, null);
    const claimed = service.notifications.claim()!;
    service.notifications.finish(claimed.id, claimed.token, { status: 'unknown' });
    service.notifications.configureQuietHours(g.goalId, { timeZone: 'UTC', startMinute: 1320, endMinute: 420 });
    time += 24 * 60 * 60 * 1000;
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.inspect(g.goalId).notifications[0].status, 'held');
  } finally { service.close(); }
});

test('quiet backlog cannot starve an unrelated goal beyond the bounded scan', async () => {
  const time = Date.parse('2026-10-27T23:00:00Z');
  const service = createService({ dbPath: ':memory:', discordOwnerId: DISCORD_BUSINESS_SCOPE.ownerId, schedulerClock: () => time });
  try {
    for (let i = 0; i < NOTIFICATION_SCAN_LIMIT; i++) {
      const g = await ready(service);
      service.notifications.configure(g.goalId, true);
      service.notifications.configureQuietHours(g.goalId, { timeZone: 'UTC', startMinute: 1320, endMinute: 420 });
      service.workspaceApprovals.create(g.goalId, g.artifactId, g.eventId);
      service.db.run('UPDATE discord_notification_outbox SET created_at=? WHERE goal_id=?', [1, g.goalId]);
    }
    const other = await ready(service);
    service.notifications.configure(other.goalId, true);
    service.workspaceApprovals.create(other.goalId, other.artifactId, other.eventId);
    service.db.run('UPDATE discord_notification_outbox SET created_at=? WHERE goal_id=?', [2, other.goalId]);
    assert.equal(service.notifications.claim(), null);
    assert.equal(service.notifications.claim()?.goalId, other.goalId);
  } finally { service.close(); }
});
