import { config } from './config.mjs';

export class Chatwoot {
  constructor(inst) { this.a = inst.account_id; this.token = inst.chatwoot_token; this.inbox = inst.inbox_id; }

  async req(method, path, body, form) {
    const headers = { api_access_token: this.token };
    let payload;
    if (form) payload = form;
    else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${config.chatwootUrl}/api/v1/accounts/${this.a}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`chatwoot ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`); e.status = res.status; throw e; }
    return text ? JSON.parse(text) : {};
  }

  listInboxes() { return this.req('GET', '/inboxes').then((r) => r.payload); }
  createInbox(name, webhookUrl) { return this.req('POST', '/inboxes', { name, channel: { type: 'api', webhook_url: webhookUrl } }); }
  updateInbox(id, webhookUrl) { return this.req('PATCH', `/inboxes/${id}`, { channel: { webhook_url: webhookUrl } }); }

  async searchContact(q) { return (await this.req('GET', `/contacts/search?q=${encodeURIComponent(q)}`)).payload; }
  getContact(id) { return this.req('GET', `/contacts/${id}`).then((r) => r.payload ?? r); }
  createContact(data) { return this.req('POST', '/contacts', data).then((r) => r.payload?.contact ?? r.payload ?? r); }
  createContactInbox(id) { return this.req('POST', `/contacts/${id}/contact_inboxes`, { inbox_id: this.inbox }); }
  listConversations(contactId) { return this.req('GET', `/contacts/${contactId}/conversations`).then((r) => r.payload); }
  createConversation(data) { return this.req('POST', '/conversations', data); }

  // Mensagem de texto e/ou anexos (multipart quando há arquivo).
  async createMessage(convId, { content, type, sourceId, replyTo, files, isPrivate }) {
    if (files?.length) {
      const f = new FormData();
      f.set('content', content ?? '');
      f.set('message_type', type);
      f.set('private', String(!!isPrivate));
      if (sourceId) f.set('source_id', sourceId);
      if (replyTo) f.set('content_attributes[in_reply_to]', String(replyTo));
      for (const file of files) f.append('attachments[]', new Blob([file.data], { type: file.mime }), file.name);
      return this.req('POST', `/conversations/${convId}/messages`, null, f);
    }
    return this.req('POST', `/conversations/${convId}/messages`, {
      content, message_type: type, private: !!isPrivate, source_id: sourceId,
      content_attributes: replyTo ? { in_reply_to: replyTo } : undefined,
    });
  }
  updateStatus(convId, msgId, status) { return this.req('PATCH', `/conversations/${convId}/messages/${msgId}`, { status }); }
  deleteMessage(convId, msgId) { return this.req('DELETE', `/conversations/${convId}/messages/${msgId}`); }
}
