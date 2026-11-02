-- The runtime role n8n's app credential connects as: DML on the tables listed below and nothing
-- else, so no DDL, no TRUNCATE, and no access to n8n's own database. docs/database.md maps every
-- statement the workflows issue to the grant that covers it. db-migrate sets the role's password
-- from APP_RUNTIME_DB_PASSWORD after every run, so this file only creates the role.
\getenv runtime_role APP_RUNTIME_DB_USER

SELECT format('CREATE ROLE %I LOGIN', :'runtime_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role')
\gexec

-- Postgres 15 and later already withhold CREATE on public from PUBLIC; this states it outright.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE n8n FROM :"runtime_role";
GRANT CONNECT ON DATABASE app TO :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role";

-- process-message records, counts, reads, and updates messages; whatsapp-entry marks them
-- replied; retention-cleanup and the dev harness's cleanup delete them.
GRANT SELECT, INSERT, UPDATE, DELETE ON inbound_messages TO :"runtime_role";

-- retention-cleanup and the dev harness's cleanup delete by session_id, and a DELETE's WHERE
-- needs SELECT. The Postgres Chat Memory node writes this table through the owner's credential
-- instead, because it runs CREATE TABLE IF NOT EXISTS on every execution (docs/database.md), so
-- this role needs no INSERT and no sequence.
GRANT SELECT, DELETE ON n8n_chat_histories TO :"runtime_role";
