CREATE SCHEMA IF NOT EXISTS evogo_bridge;

-- uma linha por instância (número) do Evolution Go ligada a uma conta/inbox do Chatwoot
CREATE TABLE IF NOT EXISTS evogo_bridge.instances (
  name                 text PRIMARY KEY,
  evogo_token          text NOT NULL,
  account_id           integer NOT NULL,
  chatwoot_token       text NOT NULL,
  inbox_id             integer,
  inbox_name           text,
  sign_msg             boolean NOT NULL DEFAULT false,
  reopen_conversation  boolean NOT NULL DEFAULT false,
  conversation_pending boolean NOT NULL DEFAULT false,
  ignore_groups        boolean NOT NULL DEFAULT true,
  enabled              boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS evogo_bridge.conversations (
  instance   text NOT NULL,
  chat_jid   text NOT NULL,
  contact_id integer NOT NULL,
  cw_conversation_id integer NOT NULL,
  PRIMARY KEY (instance, chat_jid)
);
CREATE INDEX IF NOT EXISTS conv_by_cw ON evogo_bridge.conversations (instance, cw_conversation_id);

-- mapeia id do WhatsApp <-> id da mensagem no Chatwoot (reply, edição, deleção, anti-eco)
CREATE TABLE IF NOT EXISTS evogo_bridge.messages (
  instance   text NOT NULL,
  wa_id      text NOT NULL,
  chat_jid   text NOT NULL,
  cw_message_id integer,
  cw_conversation_id integer,
  from_me    boolean NOT NULL DEFAULT false,
  sender_jid text,
  secret     text,
  content    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance, wa_id)
);
CREATE INDEX IF NOT EXISTS msg_by_cw ON evogo_bridge.messages (instance, cw_message_id);

-- token do Chatwoot por conta (cadastrado uma vez; reaproveitado por todas as instâncias da conta)
CREATE TABLE IF NOT EXISTS evogo_bridge.accounts (
  account_id     integer PRIMARY KEY,
  chatwoot_token text NOT NULL
);
ALTER TABLE evogo_bridge.instances ADD COLUMN IF NOT EXISTS import_history boolean NOT NULL DEFAULT false;
INSERT INTO evogo_bridge.accounts(account_id, chatwoot_token)
  SELECT DISTINCT ON (account_id) account_id, chatwoot_token FROM evogo_bridge.instances WHERE account_id IS NOT NULL AND chatwoot_token IS NOT NULL
  ON CONFLICT DO NOTHING;

ALTER TABLE evogo_bridge.messages ADD COLUMN IF NOT EXISTS wa_status text;

-- Chatwoot e encaminhamento (n8n/webhook) são independentes por instância
ALTER TABLE evogo_bridge.instances ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE evogo_bridge.instances ALTER COLUMN chatwoot_token DROP NOT NULL;
ALTER TABLE evogo_bridge.instances ADD COLUMN IF NOT EXISTS chatwoot_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE evogo_bridge.instances ADD COLUMN IF NOT EXISTS forward_url text;
ALTER TABLE evogo_bridge.instances ADD COLUMN IF NOT EXISTS forward_format text NOT NULL DEFAULT 'evolution-v2';
ALTER TABLE evogo_bridge.instances ADD COLUMN IF NOT EXISTS bot_name text;
ALTER TABLE evogo_bridge.instances ADD COLUMN IF NOT EXISTS bot_id integer;

-- amostras de eventos de histórico (para desenvolver/diagnosticar a importação); mantém só as últimas
CREATE TABLE IF NOT EXISTS evogo_bridge.event_samples (
  id          bigserial PRIMARY KEY,
  instance    text NOT NULL,
  event       text NOT NULL,
  size        integer NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL
);

-- importação de histórico
ALTER TABLE evogo_bridge.messages ADD COLUMN IF NOT EXISTS wa_ts timestamptz;
ALTER TABLE evogo_bridge.instances ADD COLUMN IF NOT EXISTS history_days integer NOT NULL DEFAULT 90;
CREATE TABLE IF NOT EXISTS evogo_bridge.history_imports (
  id          bigserial PRIMARY KEY,
  instance    text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running',
  chats_total integer NOT NULL DEFAULT 0, chats_done integer NOT NULL DEFAULT 0,
  msgs_total  integer NOT NULL DEFAULT 0, msgs_done  integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  error       text
);
