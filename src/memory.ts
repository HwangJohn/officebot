import type { Db } from './db.js';
import { PROPOSAL } from './fixtures.js';
import { sanitizeDiscordText } from './discordChat.js';

export type MemoryContext = {
  preferences: { key: string; value: string; source: string; observedAt: string; version: number }[];
  conversation: { role: 'user' | 'assistant'; content: string; source: string; observedAt: string }[];
};

function validScope(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 200; }

export function createMemory(db: Db, clock: () => string) {
  function rememberScoped(sourceId: string, project: string, owner: string, content: string) {
    if (!/^discord:message:\d{1,22}$/.test(sourceId) || !validScope(project) || !validScope(owner) || typeof content !== 'string' || !content.trim() || content.length > 2000 || sanitizeDiscordText(content) !== content) throw new Error('invalid_scoped_message');
    return db.tx(() => {
      const existing = db.get<{ project: string; owner: string; content: string | null }>('SELECT project,owner,content FROM memory_scoped_messages WHERE source_id=? AND version=1', [sourceId]);
      if (existing) {
        if (existing.project !== project || existing.owner !== owner || existing.content !== content.trim()) throw new Error('scoped_message_conflict');
        return { sourceId, version: 1 };
      }
      db.run('INSERT INTO memory_scoped_messages(source_id,project,owner,version,content,created_at) VALUES(?,?,?,1,?,?)', [sourceId, project, owner, content.trim(), clock()]);
      return { sourceId, version: 1 };
    });
  }
  function correctScoped(sourceId: string, project: string, owner: string, expectedVersion: number, content: string | null) {
    if (!/^discord:message:\d{1,22}$/.test(sourceId) || !validScope(project) || !validScope(owner) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || (content !== null && (typeof content !== 'string' || !content.trim() || content.length > 2000 || sanitizeDiscordText(content) !== content))) throw new Error('invalid_scoped_message');
    return db.tx(() => {
      const current = db.get<{ version: number }>('SELECT version FROM memory_scoped_messages WHERE source_id=? AND project=? AND owner=? ORDER BY version DESC LIMIT 1', [sourceId, project, owner]);
      if (!current) throw new Error('message_not_found');
      if (current.version !== expectedVersion) throw new Error('stale_message');
      const version = expectedVersion + 1;
      db.run('INSERT INTO memory_scoped_messages(source_id,project,owner,version,content,created_at) VALUES(?,?,?,?,?,?)', [sourceId, project, owner, version, content === null ? null : content.trim(), clock()]);
      return { sourceId, version, content: content === null ? null : content.trim() };
    });
  }
  function scopedMessages(project: string, owner: string) {
    if (!validScope(project) || !validScope(owner)) throw new Error('invalid_memory_scope');
    return db.all<{ sourceId: string; content: string | null; version: number; observedAt: string }>(`SELECT source_id AS sourceId,content,version,created_at AS observedAt FROM memory_scoped_messages m WHERE project=? AND owner=? AND version=(SELECT MAX(version) FROM memory_scoped_messages x WHERE x.source_id=m.source_id) ORDER BY created_at DESC,rowid DESC LIMIT 100`, [project, owner]);
  }
  function correctMessage(id: number, expectedVersion: number, content: string | null) {
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (content !== null && (typeof content !== 'string' || !content.trim() || content.length > 2000))) throw new Error('invalid_message_correction');
    return db.tx(() => {
      if (!db.get("SELECT id FROM messages WHERE id=? AND role='user'", [id])) throw new Error('message_not_found');
      const current = db.get<{ version: number }>('SELECT version FROM memory_message_corrections WHERE message_id=? ORDER BY version DESC LIMIT 1', [id]);
      if ((current?.version ?? 0) !== expectedVersion) throw new Error('stale_message');
      const version = expectedVersion + 1;
      db.run('INSERT INTO memory_message_corrections(message_id,version,content,created_at) VALUES(?,?,?,?)', [id, version, content === null ? null : content.trim(), clock()]);
      return { id, version, content: content === null ? null : content.trim() };
    });
  }
  function setPreference(project: string, owner: string, key: string, value: string | null, expectedVersion: number) {
    if (!validScope(project) || !validScope(owner) || typeof key !== 'string' || !/^[a-z0-9_-]{1,50}$/.test(key) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 400))) throw new Error('invalid_preference');
    return db.tx(() => {
      const current = db.get<{ version: number }>('SELECT version FROM memory_preferences WHERE project=? AND owner=? AND pref_key=? ORDER BY version DESC LIMIT 1', [project, owner, key]);
      if ((current?.version ?? 0) !== expectedVersion) throw new Error('stale_preference');
      const version = expectedVersion + 1;
      db.run('INSERT INTO memory_preferences(project,owner,pref_key,version,value,created_at) VALUES(?,?,?,?,?,?)', [project, owner, key, version, value === null ? null : value.trim(), clock()]);
      return { key, version, value: value === null ? null : value.trim() };
    });
  }
  function preferences(project: string, owner: string) {
    if (!validScope(project) || !validScope(owner)) throw new Error('invalid_memory_scope');
    return db.all<{ key: string; value: string | null; version: number; observedAt: string }>(`SELECT pref_key AS key,value,version,created_at AS observedAt FROM memory_preferences p
      WHERE project=? AND owner=? AND version=(SELECT MAX(version) FROM memory_preferences x WHERE x.project=p.project AND x.owner=p.owner AND x.pref_key=p.pref_key) ORDER BY pref_key`, [project, owner]);
  }
  function retrieve(project: string, owner: string, query: string): MemoryContext {
    const prefs = preferences(project, owner).filter((p): p is typeof p & { value: string } => p.value !== null).slice(0, 20).map(p => ({ ...p, source: `preference:${p.key}:v${p.version}` }));
    // Legacy web messages belong only to the existing local proposal workspace.
    const rows = project === PROPOSAL && owner === 'local' ? db.all<{ id: number; role: 'user' | 'assistant'; content: string; created_at: string; version: number }>(`SELECT m.id,m.role,CASE WHEN c.version IS NULL THEN m.content ELSE c.content END AS content,COALESCE(c.created_at,m.created_at) AS created_at,COALESCE(c.version,0) AS version
      FROM messages m LEFT JOIN memory_message_corrections c ON c.message_id=m.id AND c.version=(SELECT MAX(version) FROM memory_message_corrections WHERE message_id=m.id)
      WHERE m.role='user' AND (c.version IS NULL OR c.content IS NOT NULL) ORDER BY m.id DESC LIMIT 100`) : [];
    const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 20);
    const web = rows.map(row => ({ role: row.role, content: row.content, source: `web:message:${row.id}:v${row.version}`, observedAt: row.created_at }));
    const scoped = scopedMessages(project, owner).filter((row): row is typeof row & { content: string } => row.content !== null).map(row => ({ role: 'user' as const, content: row.content, source: `${row.sourceId}:v${row.version}`, observedAt: row.observedAt }));
    const ranked = [...web, ...scoped].map(row => ({ row, score: terms.reduce((n, term) => n + (row.content.toLocaleLowerCase().includes(term) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score || b.row.observedAt.localeCompare(a.row.observedAt) || b.row.source.localeCompare(a.row.source)).slice(0, 8).map(x => x.row).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.source.localeCompare(b.source));
    return { preferences: prefs, conversation: ranked.map(row => ({ ...row, content: row.content.slice(0, 800) })) };
  }
  return { setPreference, preferences, retrieve, correctMessage, rememberScoped, correctScoped, scopedMessages };
}
