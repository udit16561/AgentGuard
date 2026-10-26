import type { Db } from '../db';
import type { Clock } from '../clock';
import { canonicalJSON, newId, sha256 } from './canonical';
import { redact } from './redact';

export type ActorType = 'USER' | 'AGENT' | 'SYSTEM';

export interface AuditInput {
  userId: string | null;
  actorType: ActorType;
  actorId: string | null;
  eventType: string;
  actionId?: string | null;
  data?: Record<string, unknown>;
}

interface Row {
  seq: number; id: string; user_id: string | null; actor_type: string; actor_id: string | null;
  event_type: string; action_id: string | null; data: string; prev_hash: string; hash: string; created_at: number;
}

const GENESIS = '0'.repeat(64);

// everything except the hash itself is covered, so changing any stored column breaks the chain
const eventHash = (r: Omit<Row, 'hash'>) => sha256(r.prev_hash + canonicalJSON({
  seq: r.seq, id: r.id, userId: r.user_id, actorType: r.actor_type, actorId: r.actor_id,
  eventType: r.event_type, actionId: r.action_id, data: r.data, createdAt: r.created_at
}));

/**
 * Append-only, hash-chained audit log (docs/SECURITY_AND_APPROVALS.md §6).
 * This service only ever INSERTs and SELECTs; there is no update or delete method, by design.
 */
export function createAuditService(db: Db, clock: Clock, onAppend?: (e: AuditInput) => void) {
  const last = db.prepare('SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1');
  const insert = db.prepare(`INSERT INTO audit_events (seq, id, user_id, actor_type, actor_id, event_type, action_id, data, prev_hash, hash, created_at)
    VALUES (@seq, @id, @user_id, @actor_type, @actor_id, @event_type, @action_id, @data, @prev_hash, @hash, @created_at)`);

  const insertEvent = db.transaction((e: AuditInput) => {
    const prev = last.get() as { seq: number; hash: string } | undefined;
    const row: Omit<Row, 'hash'> = {
      seq: (prev?.seq ?? 0) + 1,
      id: newId('evt'),
      user_id: e.userId,
      actor_type: e.actorType,
      actor_id: e.actorId,
      event_type: e.eventType,
      action_id: e.actionId ?? null,
      data: JSON.stringify(redact(e.data ?? {})),
      prev_hash: prev?.hash ?? GENESIS,
      created_at: clock.now()
    };
    insert.run({ ...row, hash: eventHash(row) });
    return row.seq;
  });

  /** Appends one event; then announces it (live alerts), after the row is safely written. */
  function append(e: AuditInput) {
    const seq = insertEvent(e);
    if (onAppend) {
      try { onAppend(e); } catch { /* announcing must never break the audited action */ }
    }
    return seq;
  }

  function list(userId: string, f: { from?: number; to?: number; agent?: string; tool?: string; eventType?: string; limit?: number } = {}) {
    const where = ['user_id = ?'], args: unknown[] = [userId];
    if (f.from != null) { where.push('created_at >= ?'); args.push(f.from); }
    if (f.to != null) { where.push('created_at <= ?'); args.push(f.to); }
    if (f.eventType) { where.push('event_type = ?'); args.push(f.eventType); }
    if (f.agent) { where.push("(actor_id = ? OR json_extract(data, '$.agentId') = ?)"); args.push(f.agent, f.agent); }
    if (f.tool) { where.push("json_extract(data, '$.tool') = ?"); args.push(f.tool); }
    args.push(Math.min(f.limit ?? 500, 2000));
    const rows = db.prepare(`SELECT * FROM audit_events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`).all(...args) as Row[];
    return rows.map(r => ({
      seq: r.seq, id: r.id, actorType: r.actor_type, actorId: r.actor_id, eventType: r.event_type,
      actionId: r.action_id, data: safeParse(r.data), createdAt: new Date(r.created_at).toISOString(), hash: r.hash
    }));
  }

  /** Recomputes the whole chain; reports the first sequence number that does not match. */
  function verify(): { ok: true; count: number } | { ok: false; brokenAt: number; count: number } {
    const rows = db.prepare('SELECT * FROM audit_events ORDER BY seq ASC').all() as Row[];
    let prevHash = GENESIS, expectedSeq = 1;
    for (const r of rows) {
      if (r.seq !== expectedSeq || r.prev_hash !== prevHash || eventHash(r) !== r.hash) return { ok: false, brokenAt: r.seq, count: rows.length };
      prevHash = r.hash; expectedSeq++;
    }
    return { ok: true, count: rows.length };
  }

  return { append, list, verify };
}

export type AuditService = ReturnType<typeof createAuditService>;

function safeParse(s: string) { try { return JSON.parse(s); } catch { return { unreadable: true }; } }
