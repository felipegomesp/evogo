import pg from 'pg';
import { config } from './config.mjs';

// Acesso mínimo ao Postgres do Chatwoot, SÓ para devolver às mensagens importadas a data original.
// A API do Chatwoot não deixa definir created_at; então criamos tudo pela API e corrigimos as datas das linhas
// que a própria importação acabou de criar (por id), numa transação.
let pool;
export const dbConfigured = () => !!config.chatwootDbUrl;
const getPool = () => (pool ??= new pg.Pool({ connectionString: config.chatwootDbUrl, max: 2 }));

export async function fixTimestamps({ accountId, inboxId, convDisplayId, items, since, resolve }) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = items.length ? await c.query(
      `UPDATE messages m SET created_at = to_timestamp(v.ts), updated_at = to_timestamp(v.ts)
         FROM unnest($1::bigint[], $2::bigint[]) AS v(id, ts)
        WHERE m.id = v.id AND m.account_id = $3 AND m.inbox_id = $4 AND m.source_id LIKE 'WAID:%' AND m.created_at >= $5`,
      [items.map((i) => i.msgId), items.map((i) => i.ts), accountId, inboxId, since]) : { rowCount: 0 };
    const conv = (await c.query('SELECT id FROM conversations WHERE account_id = $1 AND display_id = $2', [accountId, convDisplayId])).rows[0];
    if (conv) {
      await c.query(
        `UPDATE conversations SET created_at = LEAST(conversations.created_at, s.mn), last_activity_at = s.mx
           FROM (SELECT min(created_at) AS mn, max(created_at) AS mx FROM messages WHERE conversation_id = $1) s WHERE conversations.id = $1`, [conv.id]);
      if (resolve) await c.query('UPDATE conversations SET status = 1 WHERE id = $1', [conv.id]); // 1 = resolvida
    }
    await c.query('COMMIT');
    return r.rowCount;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
