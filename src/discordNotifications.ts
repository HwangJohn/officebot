import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { DISCORD_BUSINESS_BOT_ID as botId, DISCORD_BUSINESS_SCOPE as scope } from './discordScope.js';
import { sanitizeDiscordText } from './discordChat.js';

type Row = { id: string; goal_id: string; approval_id: string; content: string; status: string; claim_token: string | null; lease_until: number | null; discord_message_id: string | null; created_at: number; updated_at: number };
type Batch = { id: string; goal_id: string; content: string; status: string; claim_token: string | null; lease_until: number | null; message_id: string | null; created_at: number };
type QuietHours = { time_zone: string; start_minute: number; end_minute: number };

// The configured wall-clock interval is interpreted in the owner's selected
// IANA timezone. Minute stepping handles DST gaps and folds without inventing a
// timezone or assuming every civil day has 24 hours.
export function nextOutsideQuietHours(time: number, quiet: QuietHours) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: quiet.time_zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const inside = (at: number) => {
    const parts = formatter.formatToParts(new Date(at));
    const minute = Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value);
    return quiet.start_minute < quiet.end_minute ? minute >= quiet.start_minute && minute < quiet.end_minute : minute >= quiet.start_minute || minute < quiet.end_minute;
  };
  if (!inside(time)) return time;
  const base = Math.floor(time / 60_000) * 60_000;
  for (let step = 1; step <= 3000; step++) { const candidate = base + step * 60_000; if (!inside(candidate)) return candidate; }
  return time + 60_000; // Recheck later if timezone data has an exceptional transition.
}

// This module never sends. The authenticated transport must confirm or hold
// each claim; an expired claim is held because Discord may already have accepted it.
export const NOTIFICATION_SCAN_LIMIT = 25;
export const NOTIFICATION_BATCH_LIMIT = 5;
export function createDiscordNotifications(db: Db, now: () => number, bridgeEnabled: boolean, eligible: (goalId: string, approvalId: string) => boolean) {
  function goal(goalId: string) {
    if (!db.get('SELECT 1 FROM workspace_goals w JOIN workflow_goals g ON g.id=w.goal_id WHERE w.goal_id=? AND w.owner=? AND g.owner=?', [goalId, 'local', 'local'])) throw new Error('workspace_goal_not_found');
  }
  function inspect(goalId: string) {
    goal(goalId);
    const setting = db.get<{ enabled: number }>('SELECT enabled FROM discord_notification_settings WHERE goal_id=?', [goalId]);
    const rows = db.all<Row & { next_check_at: number | null }>('SELECT n.id,n.goal_id,n.approval_id,COALESCE(b.content,n.content) AS content,n.status,COALESCE(n.discord_message_id,b.message_id) AS discord_message_id,n.created_at,n.updated_at,d.until_at AS next_check_at FROM discord_notification_outbox n LEFT JOIN discord_notification_deferrals d ON d.notification_id=n.id LEFT JOIN discord_notification_batch_members m ON m.notification_id=n.id LEFT JOIN discord_notification_batches b ON b.id=m.batch_id WHERE n.goal_id=? ORDER BY n.created_at,n.id', [goalId]);
    const quietHours = db.get<QuietHours>('SELECT time_zone,start_minute,end_minute FROM discord_notification_quiet_hours WHERE goal_id=?', [goalId]) ?? null;
    return { enabled: setting?.enabled === 1, bridgeAvailable: bridgeEnabled, quietHours, notifications: rows };
  }
  function configureQuietHours(goalId: string, input: unknown) {
    let quiet: QuietHours | null = null;
    if (input !== null) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'endMinute,startMinute,timeZone') throw new Error('invalid_quiet_hours');
      const value = input as { timeZone?: unknown; startMinute?: unknown; endMinute?: unknown };
      if (typeof value.timeZone !== 'string' || value.timeZone.length < 1 || value.timeZone.length > 100 || !Number.isInteger(value.startMinute) || !Number.isInteger(value.endMinute) || Number(value.startMinute) < 0 || Number(value.startMinute) > 1439 || Number(value.endMinute) < 0 || Number(value.endMinute) > 1439 || value.startMinute === value.endMinute) throw new Error('invalid_quiet_hours');
      try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format(new Date(0)); } catch { throw new Error('invalid_quiet_hours'); }
      quiet = { time_zone: value.timeZone, start_minute: Number(value.startMinute), end_minute: Number(value.endMinute) };
    }
    return db.tx(() => {
      goal(goalId);
      if (quiet) db.run('INSERT INTO discord_notification_quiet_hours(goal_id,time_zone,start_minute,end_minute,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET time_zone=excluded.time_zone,start_minute=excluded.start_minute,end_minute=excluded.end_minute,updated_at=excluded.updated_at', [goalId, quiet.time_zone, quiet.start_minute, quiet.end_minute, now()]);
      else db.run('DELETE FROM discord_notification_quiet_hours WHERE goal_id=?', [goalId]);
      db.run('DELETE FROM discord_notification_deferrals WHERE notification_id IN (SELECT id FROM discord_notification_outbox WHERE goal_id=? AND status=?)', [goalId, 'queued']);
      return inspect(goalId);
    });
  }
  function configure(goalId: string, enabled: unknown) {
    if (typeof enabled !== 'boolean') throw new Error('invalid_notification_setting');
    return db.tx(() => {
      goal(goalId);
      if (enabled && !bridgeEnabled) throw new Error('discord_bridge_unavailable');
      const time = now();
      db.run('INSERT INTO discord_notification_settings(goal_id,enabled,updated_at) VALUES(?,?,?) ON CONFLICT(goal_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at', [goalId, enabled ? 1 : 0, time]);
      if (!enabled) {
        db.run("DELETE FROM discord_notification_deferrals WHERE notification_id IN (SELECT id FROM discord_notification_outbox WHERE goal_id=? AND status='queued')", [goalId]);
        db.run("UPDATE discord_notification_outbox SET status='cancelled',updated_at=? WHERE goal_id=? AND status='queued'", [time, goalId]);
      }
      return inspect(goalId);
    });
  }
  function enqueueApproval(goalId: string, approvalId: string) {
    if (!bridgeEnabled || !db.get('SELECT 1 FROM discord_notification_settings WHERE goal_id=? AND enabled=1', [goalId])) return;
    const time = now();
    const id = `notification-${randomUUID()}`;
    const title = db.get<{ title: string }>('SELECT title FROM workflow_goals WHERE id=?', [goalId])?.title ?? '';
    const safeTitle = Array.from(sanitizeDiscordText(title).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 80).join('') || '이름 없는 목표';
    const content = `[목업 업무] 승인 검토: ${safeTitle}\n목표: ${goalId} 승인: ${approvalId} 알림: ${id}`;
    db.run("INSERT OR IGNORE INTO discord_notification_outbox(id,goal_id,approval_id,owner_id,guild_id,channel_id,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)", [id, goalId, approvalId, scope.ownerId, scope.guildId, scope.channelId, content, time, time]);
  }
  function batchFor(notificationId: string) { return db.get<Batch>('SELECT b.* FROM discord_notification_batches b JOIN discord_notification_batch_members m ON m.batch_id=b.id WHERE m.notification_id=?', [notificationId]); }
  function batchMembers(batch: Batch) {
    return db.all<Row & { owner_id: string; guild_id: string; channel_id: string }>('SELECT n.* FROM discord_notification_outbox n JOIN discord_notification_batch_members m ON m.notification_id=n.id WHERE m.batch_id=? ORDER BY m.position', [batch.id]);
  }
  function validBatch(batch: Batch) {
    const members = batchMembers(batch);
    return members.length >= 2 && members.length <= NOTIFICATION_BATCH_LIMIT && members.every(row => row.goal_id === batch.goal_id && row.owner_id === scope.ownerId && row.guild_id === scope.guildId && row.channel_id === scope.channelId) && members.map(row => row.content).join('\n\n') === batch.content;
  }
  function holdBatch(batch: Batch, time: number) {
    db.run("UPDATE discord_notification_batches SET status='held',claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='sending'", [time, batch.id]);
    db.run("UPDATE discord_notification_outbox SET status='held',claim_token=NULL,lease_until=NULL,updated_at=? WHERE status='sending' AND id IN (SELECT notification_id FROM discord_notification_batch_members WHERE batch_id=?)", [time, batch.id]);
  }
  function receiptUsed(messageId: string, exceptNotification?: string, exceptBatch?: string) {
    return !!db.get('SELECT 1 FROM discord_notification_outbox WHERE discord_message_id=? AND id<>?', [messageId, exceptNotification ?? '']) || !!db.get('SELECT 1 FROM discord_notification_batches WHERE message_id=? AND id<>?', [messageId, exceptBatch ?? '']);
  }
  function claim() {
    if (!bridgeEnabled) return null;
    return db.tx(() => {
      const time = now();
      const expiredBatches = db.all<Batch>("SELECT * FROM discord_notification_batches WHERE status='sending' AND lease_until<=? ORDER BY lease_until,id LIMIT ?", [time, NOTIFICATION_SCAN_LIMIT]);
      for (const batch of expiredBatches) holdBatch(batch, time);
      db.run("UPDATE discord_notification_outbox SET status='held',claim_token=NULL,lease_until=NULL,updated_at=? WHERE id IN (SELECT n.id FROM discord_notification_outbox n WHERE n.status='sending' AND n.lease_until<=? AND NOT EXISTS (SELECT 1 FROM discord_notification_batch_members m WHERE m.notification_id=n.id) ORDER BY n.lease_until,n.id LIMIT ?)", [time, time, NOTIFICATION_SCAN_LIMIT]);
      const rows = db.all<Row & { owner_id: string; guild_id: string; channel_id: string; enabled: number | null }>("SELECT n.*,s.enabled FROM discord_notification_outbox n LEFT JOIN discord_notification_settings s ON s.goal_id=n.goal_id LEFT JOIN discord_notification_deferrals d ON d.notification_id=n.id WHERE n.status='queued' AND (d.until_at IS NULL OR d.until_at<=?) ORDER BY n.created_at,n.id LIMIT ?", [time, NOTIFICATION_SCAN_LIMIT]);
      const nextByGoal = new Map<string, number>();
      const selected: typeof rows = [];
      for (const row of rows) {
        if (row.enabled !== 1 || row.owner_id !== scope.ownerId || row.guild_id !== scope.guildId || row.channel_id !== scope.channelId || !eligible(row.goal_id, row.approval_id)) {
          db.run('DELETE FROM discord_notification_deferrals WHERE notification_id=?', [row.id]);
          db.run("UPDATE discord_notification_outbox SET status='cancelled',updated_at=? WHERE id=? AND status='queued'", [time, row.id]);
          continue;
        }
        let next = nextByGoal.get(row.goal_id);
        if (next === undefined) {
          const quiet = db.get<QuietHours>('SELECT time_zone,start_minute,end_minute FROM discord_notification_quiet_hours WHERE goal_id=?', [row.goal_id]);
          next = quiet ? nextOutsideQuietHours(time, quiet) : time;
          nextByGoal.set(row.goal_id, next);
        }
        if (next > time) {
          db.run('INSERT INTO discord_notification_deferrals(notification_id,until_at) VALUES(?,?) ON CONFLICT(notification_id) DO UPDATE SET until_at=excluded.until_at', [row.id, next]);
          continue;
        }
        db.run('DELETE FROM discord_notification_deferrals WHERE notification_id=?', [row.id]);
        if ((!selected.length || selected[0].goal_id === row.goal_id) && selected.length < NOTIFICATION_BATCH_LIMIT && [...selected, row].map(item => item.content).join('\n\n').length <= 1800) selected.push(row);
      }
      if (!selected.length) return null;
      const first = selected[0], token = randomUUID(), leaseUntil = time + 60_000;
      for (const row of selected) db.run("UPDATE discord_notification_outbox SET status='sending',claim_token=?,lease_until=?,updated_at=? WHERE id=? AND status='queued'", [token, leaseUntil, time, row.id]);
      const content = selected.map(row => row.content).join('\n\n');
      if (selected.length > 1) {
        db.run("INSERT INTO discord_notification_batches(id,goal_id,content,status,claim_token,lease_until,created_at,updated_at) VALUES(?,?,?,'sending',?,?,?,?)", [first.id, first.goal_id, content, token, leaseUntil, time, time]);
        selected.forEach((row, position) => db.run('INSERT INTO discord_notification_batch_members(notification_id,batch_id,position) VALUES(?,?,?)', [row.id, first.id, position]));
      }
      return { id: first.id, goalId: first.goal_id, approvalId: first.approval_id, content, token, leaseUntil, scope };
    });
  }
  function finish(id: string, token: string, result: { status: 'sent'; messageId: string } | { status: 'unknown' }) {
    if (result.status === 'sent' && !/^\d{15,22}$/.test(result.messageId)) throw new Error('invalid_discord_receipt');
    return db.tx(() => {
      const time = now();
      const batch = batchFor(id);
      if (batch) {
        if (batch.id !== id || batch.status !== 'sending' || batch.claim_token !== token || batch.lease_until === null || batch.lease_until <= time || !validBatch(batch) || batchMembers(batch).some(row => row.status !== 'sending' || row.claim_token !== token || row.lease_until !== batch.lease_until)) throw new Error('notification_claim_expired');
        if (result.status === 'sent' && receiptUsed(result.messageId, undefined, batch.id)) throw new Error('discord_receipt_reused');
        const status = result.status === 'sent' ? 'sent' : 'held';
        db.run('UPDATE discord_notification_batches SET status=?,message_id=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=?', [status, result.status === 'sent' ? result.messageId : null, time, batch.id]);
        db.run('UPDATE discord_notification_outbox SET status=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id IN (SELECT notification_id FROM discord_notification_batch_members WHERE batch_id=?)', [status, time, batch.id]);
        return { status };
      }
      const row = db.get<Row>('SELECT * FROM discord_notification_outbox WHERE id=?', [id]);
      if (!row || row.status !== 'sending' || row.claim_token !== token || row.lease_until === null || row.lease_until <= time) throw new Error('notification_claim_expired');
      if (result.status === 'sent' && receiptUsed(result.messageId, id)) throw new Error('discord_receipt_reused');
      db.run('UPDATE discord_notification_outbox SET status=?,discord_message_id=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=?', [result.status === 'sent' ? 'sent' : 'held', result.status === 'sent' ? result.messageId : null, time, id]);
      return { status: result.status === 'sent' ? 'sent' : 'held' };
    });
  }
  function lookupHeld(id: string) {
    if (!bridgeEnabled) throw new Error('discord_bridge_unavailable');
    return db.tx(() => {
      const time = now();
      let batch = batchFor(id);
      if (batch) {
        if (!validBatch(batch)) throw new Error('invalid_notification_batch');
        if (batch.status === 'sending' && batch.lease_until !== null && batch.lease_until <= time) { holdBatch(batch, time); batch = batchFor(id)!; }
        if (batch.status === 'sent' && db.get('SELECT 1 FROM discord_notification_batch_reconciliation WHERE batch_id=? AND message_id=?', [batch.id, batch.message_id])) return { id, content: batch.content, createdAt: batch.created_at, status: 'sent' as const, messageId: batch.message_id };
        if (batch.status !== 'held' || batchMembers(batch).some(row => row.status !== 'held')) throw new Error('notification_not_held');
        return { id, content: batch.content, createdAt: batch.created_at, status: 'held' as const };
      }
      db.run("UPDATE discord_notification_outbox SET status='held',claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND lease_until<=?", [time, id, time]);
      const row = db.get<Row>('SELECT * FROM discord_notification_outbox WHERE id=?', [id]);
      if (row?.status === 'sent' && db.get('SELECT 1 FROM discord_notification_reconciliation WHERE notification_id=? AND message_id=?', [id, row.discord_message_id])) return { id: row.id, content: row.content, createdAt: row.created_at, status: 'sent' as const, messageId: row.discord_message_id };
      if (!row || row.status !== 'held') throw new Error('notification_not_held');
      return { id: row.id, content: row.content, createdAt: row.created_at, status: 'held' as const };
    });
  }
  // Only the authenticated Discord runtime may submit a message it fetched from
  // Discord itself. Validate it again against server-owned expected content.
  function reconcile(id: string, commandMessageId: string, receipt: unknown) {
    if (!bridgeEnabled || !/^\d{15,22}$/.test(commandMessageId) || !receipt || typeof receipt !== 'object') throw new Error('invalid_notification_receipt');
    const proof = receipt as { id?: unknown; channel_id?: unknown; author?: { id?: unknown; bot?: unknown }; webhook_id?: unknown; content?: unknown; timestamp?: unknown };
    if (typeof proof.id !== 'string' || !/^\d{15,22}$/.test(proof.id) || proof.channel_id !== scope.channelId || proof.author?.id !== botId || proof.author?.bot !== true || proof.webhook_id != null || typeof proof.content !== 'string' || typeof proof.timestamp !== 'string') throw new Error('invalid_notification_receipt');
    const messageId = proof.id, messageTimestamp = proof.timestamp, content = proof.content;
    const messageTime = Date.parse(messageTimestamp);
    if (!Number.isFinite(messageTime)) throw new Error('invalid_notification_receipt');
    return db.tx(() => {
      const row = db.get<Row & { owner_id: string; guild_id: string; channel_id: string }>('SELECT * FROM discord_notification_outbox WHERE id=?', [id]);
      const batch = batchFor(id);
      if (batch) {
        if (!row || !validBatch(batch) || batch.content !== content || messageTime < batch.created_at || messageTime > now() + 60_000) throw new Error('invalid_notification_receipt');
        const existing = db.get<{ message_id: string }>('SELECT message_id FROM discord_notification_batch_reconciliation WHERE batch_id=?', [batch.id]);
        if (existing && batch.status === 'sent' && existing.message_id === messageId && batch.message_id === messageId) return { status: 'sent' as const };
        if (batch.status !== 'held' || batchMembers(batch).some(member => member.status !== 'held')) throw new Error('notification_not_held');
        if (receiptUsed(messageId, undefined, batch.id)) throw new Error('discord_receipt_reused');
        const time = now();
        db.run('INSERT INTO discord_notification_batch_reconciliation(batch_id,message_id,owner_id,command_message_id,verified_at,message_timestamp,content_hash) VALUES(?,?,?,?,?,?,?)', [batch.id, messageId, scope.ownerId, commandMessageId, time, messageTimestamp, createHash('sha256').update(batch.content).digest('hex')]);
        db.run("UPDATE discord_notification_batches SET status='sent',message_id=?,updated_at=? WHERE id=? AND status='held'", [messageId, time, batch.id]);
        db.run("UPDATE discord_notification_outbox SET status='sent',updated_at=? WHERE status='held' AND id IN (SELECT notification_id FROM discord_notification_batch_members WHERE batch_id=?)", [time, batch.id]);
        return { status: 'sent' as const };
      }
      if (!row || row.owner_id !== scope.ownerId || row.guild_id !== scope.guildId || row.channel_id !== scope.channelId || row.content !== content || messageTime < row.created_at || messageTime > now() + 60_000) throw new Error('invalid_notification_receipt');
      const existing = db.get<{ message_id: string }>('SELECT message_id FROM discord_notification_reconciliation WHERE notification_id=?', [id]);
      if (existing && row.status === 'sent' && existing.message_id === messageId && row.discord_message_id === messageId) return { status: 'sent' as const };
      if (row.status !== 'held') throw new Error('notification_not_held');
      if (receiptUsed(messageId, id)) throw new Error('discord_receipt_reused');
      const time = now();
      db.run('INSERT INTO discord_notification_reconciliation(notification_id,message_id,owner_id,command_message_id,verified_at,message_timestamp,content_hash) VALUES(?,?,?,?,?,?,?)', [id, messageId, scope.ownerId, commandMessageId, time, messageTimestamp, createHash('sha256').update(row.content).digest('hex')]);
      db.run("UPDATE discord_notification_outbox SET status='sent',discord_message_id=?,updated_at=? WHERE id=? AND status='held'", [messageId, time, id]);
      return { status: 'sent' as const };
    });
  }
  return { configure, configureQuietHours, inspect, enqueueApproval, claim, finish, lookupHeld, reconcile };
}
