import pg from 'pg';
import fs from 'node:fs';
import { config } from './config.mjs';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });

export async function migrate() {
  await pool.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}

const T = 'evogo_bridge.';
export const db = {
  async instances() { return (await pool.query(`select * from ${T}instances where enabled`)).rows; },
  async allInstances() { return (await pool.query(`select * from ${T}instances order by name`)).rows; },
  async accountIds() { return (await pool.query(`select account_id from ${T}accounts order by account_id`)).rows.map((r) => r.account_id); },
  async account(id) { return (await pool.query(`select * from ${T}accounts where account_id=$1`, [id])).rows[0]; },
  async saveAccount(id, token) {
    await pool.query(`insert into ${T}accounts(account_id,chatwoot_token) values($1,$2) on conflict (account_id) do update set chatwoot_token=$2`, [id, token]);
    await pool.query(`update ${T}instances set chatwoot_token=$2 where account_id=$1`, [id, token]);
  },
  async upsertInstance(i) {
    await pool.query(`insert into ${T}instances(name,evogo_token,account_id,chatwoot_token,inbox_id,inbox_name,sign_msg,reopen_conversation,conversation_pending,ignore_groups,import_history,chatwoot_enabled,forward_url,forward_format,bot_name,bot_id,history_days,enabled)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true)
      on conflict (name) do update set evogo_token=$2, account_id=$3, chatwoot_token=$4, inbox_id=$5, inbox_name=$6, sign_msg=$7,
        reopen_conversation=$8, conversation_pending=$9, ignore_groups=$10, import_history=$11, chatwoot_enabled=$12, forward_url=$13, forward_format=$14, bot_name=$15, bot_id=$16, history_days=$17, enabled=true`,
      [i.name, i.evogo_token, i.account_id ?? null, i.chatwoot_token ?? null, i.inbox_id ?? null, i.inbox_name ?? null, !!i.sign_msg, !!i.reopen_conversation,
        !!i.conversation_pending, i.ignore_groups !== false, !!i.import_history, !!i.chatwoot_enabled, i.forward_url || null, i.forward_format || 'evolution-v2', i.bot_name || null, i.bot_id ?? null, Number.isInteger(i.history_days) ? i.history_days : 90]);
  },
  async removeInstance(name) { await pool.query(`delete from ${T}instances where name=$1`, [name]); },
  async disable(name) { await pool.query(`update ${T}instances set enabled=false where name=$1`, [name]); },
  async instance(name) { return (await pool.query(`select * from ${T}instances where name=$1 and enabled`, [name])).rows[0]; },
  async setInbox(name, id, inboxName) { await pool.query(`update ${T}instances set inbox_id=$2, inbox_name=$3 where name=$1`, [name, id, inboxName]); },

  async conv(instance, chat) { return (await pool.query(`select * from ${T}conversations where instance=$1 and chat_jid=$2`, [instance, chat])).rows[0]; },
  async convByCw(instance, cwId) { return (await pool.query(`select * from ${T}conversations where instance=$1 and cw_conversation_id=$2`, [instance, cwId])).rows[0]; },
  async saveConv(instance, chat, contactId, convId) {
    await pool.query(`insert into ${T}conversations(instance,chat_jid,contact_id,cw_conversation_id) values($1,$2,$3,$4)
      on conflict (instance,chat_jid) do update set contact_id=$3, cw_conversation_id=$4`, [instance, chat, contactId, convId]);
  },
  // Troca de conta/inbox: as conversas/mensagens em cache pertencem ao destino antigo (ids de conversa são por conta)
  async resetChatwootLinks(instance) {
    await pool.query(`delete from ${T}conversations where instance=$1`, [instance]);
    await pool.query(`update ${T}messages set cw_message_id=null, cw_conversation_id=null where instance=$1`, [instance]);
  },
  async dropConv(instance, chat) { await pool.query(`delete from ${T}conversations where instance=$1 and chat_jid=$2`, [instance, chat]); },

  async msg(instance, waId) { return (await pool.query(`select * from ${T}messages where instance=$1 and wa_id=$2`, [instance, waId])).rows[0]; },
  async msgByCw(instance, cwId) { return (await pool.query(`select * from ${T}messages where instance=$1 and cw_message_id=$2`, [instance, cwId])).rows[0]; },
  async saveMsg(m) {
    await pool.query(`insert into ${T}messages(instance,wa_id,chat_jid,cw_message_id,cw_conversation_id,from_me,sender_jid,secret,content,wa_ts)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,case when $10::bigint is null then null else to_timestamp($10) end)
      on conflict (instance,wa_id) do update set cw_message_id=coalesce($4,${T}messages.cw_message_id),
        cw_conversation_id=coalesce($5,${T}messages.cw_conversation_id), secret=coalesce($8,${T}messages.secret), content=coalesce($9,${T}messages.content),
        wa_ts=coalesce(case when $10::bigint is null then null else to_timestamp($10) end, ${T}messages.wa_ts)`,
      [m.instance, m.wa_id, m.chat_jid, m.cw_message_id ?? null, m.cw_conversation_id ?? null, !!m.from_me, m.sender_jid ?? null, m.secret ?? null, m.content ?? null, m.wa_ts ?? null]);
  },
  async saveSample(instance, event, size, payload) {
    await pool.query(`insert into ${T}event_samples(instance,event,size,payload) values($1,$2,$3,$4)`, [instance, event, size, JSON.stringify(payload)]);
    await pool.query(`delete from ${T}event_samples where id not in (select id from ${T}event_samples order by id desc limit 20)`);
  },
  async samples(instance) { return (await pool.query(`select payload from ${T}event_samples where instance=$1 and event='HistorySync' order by id`, [instance])).rows.map((r) => r.payload); },
  async purgeSamples(instance) { return (await pool.query(`delete from ${T}event_samples where instance=$1`, [instance])).rowCount; },
  async startRun(instance, chats, msgs) { return (await pool.query(`insert into ${T}history_imports(instance,chats_total,msgs_total) values($1,$2,$3) returning id`, [instance, chats, msgs])).rows[0].id; },
  async updateRun(id, patch) {
    const keys = Object.keys(patch); if (!keys.length) return;
    await pool.query(`update ${T}history_imports set ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} where id=$1`, [id, ...keys.map((k) => patch[k])]);
  },
  async stats() {
    const r = await pool.query(`select i.name,
      (select count(*) from ${T}conversations c where c.instance=i.name)::int as conversations,
      (select count(*) from ${T}messages m where m.instance=i.name)::int as messages,
      (select count(*) from ${T}messages m where m.instance=i.name and m.created_at > now() - interval '24 hours')::int as messages_24h,
      (select max(m.created_at) from ${T}messages m where m.instance=i.name) as last_message
      from ${T}instances i`);
    return new Map(r.rows.map((x) => [x.name, x]));
  },
  async lastRunWithMessages(instance) { return (await pool.query(`select * from ${T}history_imports where instance=$1 and msgs_done>0 order by id desc limit 1`, [instance])).rows[0]; },
  async lastRun(instance) { return (await pool.query(`select * from ${T}history_imports where instance=$1 order by id desc limit 1`, [instance])).rows[0]; },
  async setStatus(instance, waId, status) { await pool.query(`update ${T}messages set wa_status=$3 where instance=$1 and wa_id=$2`, [instance, waId, status]); },
  async setContent(instance, waId, content) { await pool.query(`update ${T}messages set content=$3 where instance=$1 and wa_id=$2`, [instance, waId, content]); },
  async dropMsg(instance, waId) { await pool.query(`delete from ${T}messages where instance=$1 and wa_id=$2`, [instance, waId]); },
};
