CREATE TABLE inbound_messages (
  message_id  text PRIMARY KEY,
  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'test')),
  phone       text NOT NULL,
  body        text,
  triage      jsonb,
  route       text,
  received_at timestamptz NOT NULL DEFAULT now(),
  replied_at  timestamptz
);
CREATE INDEX inbound_messages_phone_received_idx ON inbound_messages (phone, received_at DESC);

CREATE TABLE IF NOT EXISTS n8n_chat_histories (
  id         serial PRIMARY KEY,
  session_id varchar(255) NOT NULL,
  message    jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS n8n_chat_histories_session_idx ON n8n_chat_histories (session_id);
