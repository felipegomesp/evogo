import { config } from './config.mjs';
import { log } from './log.mjs';
import { db } from './db.mjs';
import { Chatwoot } from './chatwoot.mjs';

export async function ensureInbox(inst) {
  const cw = new Chatwoot(inst);
  const url = `${config.bridgeUrl}/chatwoot/${inst.name}/${config.secret}`;
  const name = inst.inbox_name || `${inst.name}-evogo`;
  let id = inst.inbox_id;
  if (!id) id = (await cw.listInboxes()).find((i) => i.name === name)?.id;
  if (id) await cw.updateInbox(id, url); else id = (await cw.createInbox(name, url)).id;
  await db.setInbox(inst.name, id, name);
  log.info('inbox pronta', { inst: inst.name, inbox: id });
}
