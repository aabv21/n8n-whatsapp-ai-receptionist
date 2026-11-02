-- retention-cleanup's "Delete expired messages" filters on received_at alone. The baseline
-- (phone, received_at) index can't serve that as a range without a leading phone, so Postgres 17
-- reads it whole; this index turns the daily delete into a range scan. An index always belongs
-- to its table's owner, so this needs no SET ROLE to end up owned by app.
-- NOTE: A plain CREATE INDEX blocks writes to the table while it builds, which is brief at this
-- table's size. A large production table would take CREATE INDEX CONCURRENTLY, which can't run
-- inside db-migrate's transaction, so it would ship as a separately applied step.
CREATE INDEX IF NOT EXISTS inbound_messages_received_at_idx ON inbound_messages (received_at);
