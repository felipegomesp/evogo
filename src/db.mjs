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
    await pool.query(`insert into ${T}instances(name,evogo_token,account_id,chatwoot_token,inbox_id,inbox_name,sign_msg,reopen_conversation,conversation_pending,ignore_groups,import_history,enabled)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
      on conflict (name) do update set evogo_token=$2, account_id=$3, chatwoot_token=$4, inbox_id=$5, inbox_name=$6, sign_msg=$7,
        reopen_conversation=$8, conversation_pending=$9, ignore_groups=$10, import_history=$11, enabled=true`,
      [i.name, i.evogo_token, i.account_id, i.chatwoot_token, i.inbox_id ?? null, i.inbox_name, i.sign_msg, i.reopen_conversation, i.conversation_pending, i.ignore_groups, i.import_history]);
  },
  async disable(name) { await pool.query(`update ${T}instances set enabled=false where name=$1`, [name]); },
  async instance(name) { return (await pool.query(`select * from ${T}instances where name=$1 and enabled`, [name])).rows[0]; },
  async setInbox(name, id, inboxName) { await pool.query(`update ${T}instances set inbox_id=$2, inbox_name=$3 where name=$1`, [name, id, inboxName]); },

  async conv(instance, chat) { return (await pool.query(`select * from ${T}conversations where instance=$1 and chat_jid=$2`, [instance, chat])).rows[0]; },
  async convByCw(instance, cwId) { return (await pool.query(`select * from ${T}conversations where instance=$1 and cw_conversation_id=$2`, [instance, cwId])).rows[0]; },
  async saveConv(instance, chat, contactId, convId) {
    await pool.query(`insert into ${T}conversations(instance,chat_jid,contact_id,cw_conversation_id) values($1,$2,$3,$4)
      on conflict (instance,chat_jid) do update set contact_id=$3, cw_conversation_id=$4`, [instance, chat, contactId, convId]);
  },
  async dropConv(instance, chat) { await pool.query(`delete from ${T}conversations where instance=$1 and chat_jid=$2`, [instance, chat]); },

  async msg(instance, waId) { return (await pool.query(`select * from ${T}messages where instance=$1 and wa_id=$2`, [instance, waId])).rows[0]; },
  async msgByCw(instance, cwId) { return (await pool.query(`select * from ${T}messages where instance=$1 and cw_message_id=$2`, [instance, cwId])).rows[0]; },
  async saveMsg(m) {
    await pool.query(`insert into ${T}messages(instance,wa_id,chat_jid,cw_message_id,cw_conversation_id,from_me,sender_jid,secret,content)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (instance,wa_id) do update set cw_message_id=coalesce($4,${T}messages.cw_message_id),
        cw_conversation_id=coalesce($5,${T}messages.cw_conversation_id), secret=coalesce($8,${T}messages.secret), content=coalesce($9,${T}messages.content)`,
      [m.instance, m.wa_id, m.chat_jid, m.cw_message_id ?? null, m.cw_conversation_id ?? null, !!m.from_me, m.sender_jid ?? null, m.secret ?? null, m.content ?? null]);
  },
  async setStatus(instance, waId, status) { await pool.query(`update ${T}messages set wa_status=$3 where instance=$1 and wa_id=$2`, [instance, waId, status]); },
  async setContent(instance, waId, content) { await pool.query(`update ${T}messages set content=$3 where instance=$1 and wa_id=$2`, [instance, waId, content]); },
  async dropMsg(instance, waId) { await pool.query(`delete from ${T}messages where instance=$1 and wa_id=$2`, [instance, waId]); },
};
