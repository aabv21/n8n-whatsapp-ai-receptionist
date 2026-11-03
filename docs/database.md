# How the database is run

One Postgres 17 server holds two databases: `n8n`, n8n's own (workflows, credentials, executions), and `app`, the receptionist's (`inbound_messages`, `n8n_chat_histories`, and the migration ledger `schema_migrations`). This page covers which role reaches what, every statement the workflows issue and the grant behind it, how schema changes ship, how long personal data stays, backup and restore, and how `node scripts/check-db.ts` proves the protections hold. The [architecture doc](architecture.md) covers the data model's place in the message lifecycle.

## Roles

| Role | Owns | Used by | Can |
|---|---|---|---|
| `postgres` (`POSTGRES_USER`) | the server | `db/init/` and `db-migrate`, over the `postgres` container's local socket | Everything. It's never configured in the n8n container. |
| `n8n` (`N8N_DB_USER`) | database `n8n` | n8n itself | Its own database only. |
| `app` (`APP_DB_USER`) | database `app` and its tables | the `App DB (chat memory)` credential, which only the Postgres Chat Memory node uses | Everything in `app`. |
| `app_runtime` (`APP_RUNTIME_DB_USER`) | nothing | the `App DB` credential, which every Postgres node uses | The DML listed below, and nothing else. |

`db/migrations/001_runtime_role.sql` creates `app_runtime` and grants it, table by table, exactly what the statements below need.

### Why the Postgres Chat Memory node connects as the owner

The node can't run as `app_runtime`. In n8n 2.45.6, `MemoryPostgresChat.node.js` builds a `PostgresChatMessageHistory` (`@langchain/community` 1.1.27) for each execution. That class calls `ensureTable()` before its first read or write, and `ensureTable()` always sends `CREATE TABLE IF NOT EXISTS "n8n_chat_histories" (…)`. It ignores only error `23505`.

Postgres checks `CREATE` on the target schema before it checks whether the table exists. So the statement fails without that privilege even when the table is already there. Run as `app_runtime` against the local stack, with the table in place:

- that exact statement fails with `ERROR: permission denied for schema public`;
- n8n's own bundled class, called inside the n8n container, fails its first `getMessages()` with `42501 permission denied for schema public`;
- the same class, called as `app`, reads, adds, and clears messages.

Pre-creating the table doesn't help, because the node never skips its DDL. Granting `app_runtime` `CREATE` on `public` would let every Postgres node create tables. So the memory node gets its own credential, `App DB (chat memory)`, built from `APP_DB_USER` and `APP_DB_PASSWORD`. Every other node keeps `app_runtime`.

The trade-off is that `app`'s password sits in n8n's encrypted credential store, where anyone who can edit workflows could attach it to a Postgres node. The node issues DDL on every execution, and giving `app_runtime` `CREATE` would undo the point of a runtime role. A third, memory-only role was judged not worth its extra credential and `.env` names, so `tests/tooling.test.ts` instead pins the Postgres Chat Memory node as the credential's only user.

## Every statement and what covers it

The twelve Postgres node statements run as `app_runtime`. The last four rows are the Chat Memory node's, which run as `app`. Each `UPDATE`'s and `DELETE`'s `WHERE`, and the insert's conflict check, read columns, so they need `SELECT` as well; this was checked against Postgres 17 with a role that held only the write privilege. The "Served by" column comes from `EXPLAIN` on Postgres 17.11.

| Workflow › node | Statement | Privileges it needs | Served by |
|---|---|---|---|
| `process-message` › Record inbound message | `INSERT INTO inbound_messages … ON CONFLICT (message_id) DO NOTHING RETURNING 1`, counted | `INSERT`; `SELECT` for the conflict check | primary key, as the conflict arbiter |
| `process-message` › Count recent messages | `SELECT count(*) … WHERE phone = $1 AND received_at > now() - make_interval(mins => $2) AND body IS NOT NULL` | `SELECT` | `inbound_messages_phone_received_idx` |
| `process-message` › Recent patient messages | `SELECT … WHERE phone = $1 AND message_id <> $2 AND body IS NOT NULL ORDER BY received_at DESC LIMIT 3` | `SELECT` | `inbound_messages_phone_received_idx` |
| `process-message` › Save triage | `UPDATE inbound_messages SET triage = $2::jsonb WHERE message_id = $1` | `UPDATE`, `SELECT` | primary key |
| `process-message` › Save route | `UPDATE inbound_messages SET route = $2 WHERE message_id = $1` | `UPDATE`, `SELECT` | primary key |
| `notify-team` › Check alert cooldown | `SELECT EXISTS (SELECT 1 FROM inbound_messages WHERE phone = $1 AND received_at > now() - make_interval(mins => $2) AND triage->>'team_alerted' = 'true') AS alerted` | `SELECT` | `inbound_messages_phone_received_idx` |
| `notify-team` › Mark team alerted | `UPDATE inbound_messages SET triage = coalesce(triage, '{}'::jsonb) \|\| '{"team_alerted": true}' WHERE message_id = $1` | `UPDATE`, `SELECT` | primary key |
| `whatsapp-entry` › Mark replied | `UPDATE inbound_messages SET replied_at = now() WHERE message_id = $1` | `UPDATE`, `SELECT` | primary key |
| `retention-cleanup` › Delete expired chat memory | `DELETE FROM n8n_chat_histories h WHERE NOT EXISTS (SELECT 1 FROM inbound_messages m WHERE (h.session_id = m.phone OR h.session_id = 'test:' \|\| m.phone) AND m.received_at >= now() - make_interval(days => $1))` | `DELETE`, `SELECT` on `n8n_chat_histories`; `SELECT` on `inbound_messages` | a full read of `n8n_chat_histories`, an anti-join that must judge every row (see item 3); the subquery's age range reads `inbound_messages_received_at_idx` |
| `retention-cleanup` › Delete expired messages | `DELETE FROM inbound_messages WHERE received_at < now() - make_interval(days => $1)` | `DELETE`, `SELECT` | `inbound_messages_received_at_idx`, as a range |
| `dev-harness` › Delete test messages | `DELETE FROM inbound_messages WHERE starts_with(phone, $1) RETURNING 1`, counted | `DELETE`, `SELECT` | a full read; test tooling (see item 3) |
| `dev-harness` › Delete test memories | `DELETE FROM n8n_chat_histories WHERE starts_with(session_id, 'test:' \|\| $1) OR starts_with(session_id, $1) RETURNING 1`, counted | `DELETE`, `SELECT` | a full read; test tooling (see item 3) |
| `process-message` › Postgres Chat Memory, once per execution | `CREATE TABLE IF NOT EXISTS "n8n_chat_histories" (…)` | `CREATE` on schema `public`: the owner | n/a |
| same, loading the history | `SELECT message FROM "n8n_chat_histories" WHERE session_id = $1 ORDER BY id` | the owner | `n8n_chat_histories_session_idx` |
| same, saving each turn | `INSERT INTO "n8n_chat_histories" (session_id, message) VALUES ($1, $2)` | the owner, including the `id` sequence | primary key |
| same, `clear()`, which the agent never calls | `DELETE FROM "n8n_chat_histories" WHERE session_id = $1` | the owner | `n8n_chat_histories_session_idx` |

So `app_runtime` holds `SELECT, INSERT, UPDATE, DELETE` on `inbound_messages` and `SELECT, DELETE` on `n8n_chat_histories`. It needs no sequence, and it has nothing on `schema_migrations`.

## The checklist

### 1. Roles

- **The schema owner isn't the runtime role.** `app` owns every table in `app`, including `schema_migrations`, which `db-migrate` creates under `SET LOCAL ROLE`. n8n's app credential, `App DB`, connects as `app_runtime`.
- **What `app_runtime` can't do.**
  - **DML only.** It has DML only on the two tables above, and no DDL in `app`: `001_runtime_role.sql` runs `REVOKE CREATE ON SCHEMA public FROM PUBLIC` and grants it nothing beyond `USAGE`.
  - **No wider grants.** It has no `TRUNCATE`, and no column-level grant beyond its table grants.
  - **No membership.** It's a member of no role, so it can't `SET ROLE` to the owner.
  - **No attributes.** `db-migrate` re-asserts `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` every time it sets the password.
  - **No `n8n`.** `db/init/` revokes `PUBLIC`'s access, and the migration runs `REVOKE ALL ON DATABASE n8n FROM app_runtime`.
  - **`CONNECT` on `app`, without `TEMP`.** `db/init/` revoked `PUBLIC`'s defaults there.
- **Its own name.** `db-migrate` refuses to run when `APP_RUNTIME_DB_USER` equals `POSTGRES_USER`, `N8N_DB_USER`, or `APP_DB_USER`, which would aim the runtime grants and password at another role.
- **No default privileges.** A new table gets its grants in its own migration.
- **The superuser stays out of n8n.** It runs only `db/init/` and `db-migrate`, and neither n8n container is configured with it.
- **The one exception** is the Chat Memory node's owner credential, above.
- **The `postgres` maintenance database** keeps its default `PUBLIC` `CONNECT` and `TEMP`, so `app_runtime` can connect there and create temporary tables. This repo leaves that database alone: it holds no data, and nothing in it reaches `app` or `n8n`.

NOTE: Grants are table-level. Column-level `UPDATE` grants would stop a leaked runtime credential from rewriting a column such as `received_at`, but every grant check would then have to compare columns too. `check-db` already flags any column grant beyond the table-level list.

### 2. Schema

- **Primary keys:** every table has one: `inbound_messages (message_id)`, `n8n_chat_histories (id)`, and `schema_migrations (filename)`.
- **CHECKs on enumerated columns:** `channel` has had one since the baseline (`whatsapp`, `test`). `002_route_check.sql` adds one on `route`, listing exactly what `process-message`'s "Save route" writes: `src/nodes/decide-route.ts`'s `agent`, `blocked`, `emergency`, and `handoff`, plus `process-message`'s own `fallback`, `non_text`, and `rate_limited`, or `NULL`. `tests/db-migrate.test.ts` derives that list from the node and the workflow, so neither can drift from the constraint.
- **`NOT NULL`:** set on every required value: `channel`, `phone`, `received_at`, `session_id`, `message`, and `applied_at`. Four columns are nullable on purpose:
  - `body`: `NULL` for a non-text message;
  - `triage`: `NULL` until it's saved;
  - `route`: `NULL` until it's saved, and always for a duplicate;
  - `replied_at`: `NULL` until a send succeeds.
- **Timestamps** are `timestamptz`. This repo has no MySQL.

### 3. Indexes

Every statement a production path runs is served by the primary key or an index, as the table above shows, except the chat-history cleanup below. The plans come from `EXPLAIN` on Postgres 17.11.

- **The baseline index.** `(phone, received_at)` serves the per-message count, the recent-messages lookup, and `notify-team`'s alert cooldown check.
- **The age delete.** `003_received_at_index.sql` adds `inbound_messages_received_at_idx` for `retention-cleanup`'s "Delete expired messages", which filters on `received_at` alone. Without it, Postgres 17, which has no skip scan, would read the whole `(phone, received_at)` index for that delete. With it, the delete is a range scan.

Two documented exceptions read a whole table, on purpose:

- **Delete expired chat memory** is an anti-join: it keeps a history row only while its phone has a recent message, so it must read every row of `n8n_chat_histories`, and it scans by nature. Its inner side, the recent messages, is a range on `inbound_messages_received_at_idx`. It runs once a day, and retention itself bounds the table it scans.
- **The dev harness's two deletes** are test tooling, not a production path. They match a phone prefix with `starts_with`, which a B-tree under the database's default collation can't serve, and they only ever touch test data.

### 4. Queries

- **Bound values only.** Every Postgres node passes its values as `$n` Query Parameters. `pnpm run check` rejects a query that contains a `{{ }}` expression.
- **The Chat Memory node's SQL** is the library's own, also with `$1` and `$2`. The node passes the table name through its `escapeQualifiedSqlIdentifier` first.
- **CI runs every statement.** `check-db` runs each workflow statement exactly as the workflow wrote it, with psql's `\bind` supplying the values.

### 5. Migrations

`db/schema.sql` is the baseline, which `db/init/` loads on an empty volume. Every change after it is a file in `db/migrations/`, named `NNN_short_name.sql`. `pnpm run db:migrate` (`scripts/db-migrate.ts`) applies them, and `pnpm run setup` runs it first. On each run, it:

1. **Checks the files and `.env` first.** It stops before touching the database in three cases. Each error names files and variables, never a value.
   - A file contains a transaction-control statement (`BEGIN`, `COMMIT`, `ROLLBACK`, `ABORT`, `START TRANSACTION`, or `END`), which would split the file from its ledger row.
   - `APP_RUNTIME_DB_USER` names the same role as another role variable.
   - A variable that a pending file reads with `\getenv` is unset or empty.
2. **Opens the ledger.** As the owner role, it creates `schema_migrations` if it's missing, then reads the files already recorded there.
3. **Applies each pending file in order,** as the superuser over the container's local socket, with `--single-transaction` and `ON_ERROR_STOP`. Each file's transaction first takes a fixed advisory lock (`pg_advisory_xact_lock`), so two runs can't interleave. A concurrent second run then fails on the ledger's primary key instead of recording a file twice. The `INSERT` into `schema_migrations` is the file's last statement, so a failed file leaves no change and no record.
4. **Sets `app_runtime`'s password and attributes** from `APP_RUNTIME_DB_PASSWORD`, even when no migration ran, with `ALTER ROLE … WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD …`. A hand-granted attribute doesn't survive the next run. `setup-credentials` rebuilds the `App DB` credential from `.env` on every run, so the role's password must follow it the same way. To rotate it, change `.env` and run `pnpm run setup`.

`db-migrate` passes each variable to `docker compose exec` as a bare `-e NAME`. Docker copies the value from `db-migrate`'s own environment, so it never appears in an argument list or in `ps`, and psql reads it with `\getenv`. A password reaches the server only inside `ALTER ROLE … PASSWORD`, which psql quotes itself. `db-migrate` redacts every `.env` secret from psql's output before printing an error.

Postgres also logs a failed statement's full text by default (`log_min_error_statement = error`), and `ALTER ROLE … PASSWORD` carries the password. So the password step first runs `SET LOCAL log_min_error_statement = panic` and `SET LOCAL log_statement = 'none'` inside its own transaction. `db/init/` does the same for its session before it creates the n8n and app roles. A failed `ALTER ROLE` then logs its error, never its statement. `db/init/` also stops at once if `N8N_DB_PASSWORD` or `APP_DB_PASSWORD` is empty.

A file must be safe to run twice:

- `001` creates the role through `\gexec` only `WHERE NOT EXISTS`.
- `002` adds its constraint inside a `DO` block guarded on `pg_constraint`.
- `003` creates its index `IF NOT EXISTS`. An index belongs to its table's owner, so it needs no `SET ROLE`. A plain `CREATE INDEX` blocks writes while it builds, which is brief at this size; a large production table would need `CREATE INDEX CONCURRENTLY`, which can't run inside a transaction, as a separate step.
- `GRANT` and `REVOKE` are idempotent.

The ledger already skips applied files, so a second `pnpm run setup` prints `no pending migrations`. A migration that creates a table starts with `\getenv owner APP_DB_USER` and `SET LOCAL ROLE :"owner";`, so `app` owns the table, not the superuser. `001` reads `APP_RUNTIME_DB_USER` once, so renaming the role later takes a new migration.

### 6. Retention

**App tables:**

| Table | Personal data | Deleted by | When |
|---|---|---|---|
| `inbound_messages` | phone, message text | `retention-cleanup` | daily at 03:00 Bogota, once `received_at` is older than `config.limits.retention_days` (30 by default) |
| `n8n_chat_histories` | phone (in `session_id`), the conversation | `retention-cleanup` | the same run, once its phone has no message left inside `retention_days` |
| `schema_migrations` | none | nothing | it's the ledger |

The dev harness's `cleanup` target deletes test rows by phone prefix whenever it's called.

**n8n execution data:** `compose.yaml` keeps `EXECUTIONS_DATA_PRUNE=true` and `EXECUTIONS_DATA_MAX_AGE=168`, so n8n deletes executions after 168 hours. A manual execution, started from the editor, is saved by default with every node's input and output. Every workflow in `workflows/` sets `settings.saveManualExecutions: false`, and `tests/workflows/execution-data.test.ts` asserts it for every file.

A per-workflow list wouldn't hold. Most workflows carry a patient's phone, name, or message text, or the dev harness's `X-Dev-Token` header. `error-handler` can quote a failed row, such as Postgres's "Failing row contains (…)". Even `load-context` and `retention-cleanup`, which only read config and delete, start from an Execute Workflow Trigger in `passthrough` mode, and their callers send no input schema. So each receives its caller's whole item, such as `process-message`'s patient message, or the dev harness's request with its token.

Production executions are still saved, then pruned at 168 hours.

### 7. Backup and restore

Back up `app` from the running stack. Every command runs in the `postgres` container, so no port or password crosses the host. A dump holds personal data, so write it outside the repo, with a `0600` mode:

```bash
mkdir -p ~/cumbident-backups
(umask 077; docker compose exec -T postgres sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d app' > ~/cumbident-backups/app.dump)
```

To check a dump, restore it into a scratch database, compare the row counts, then drop only that database:

```bash
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" -O "$APP_DB_USER" app_restore_check'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d app_restore_check --exit-on-error' < ~/cumbident-backups/app.dump
for db in app app_restore_check; do
  docker compose exec -T postgres sh -c "psql -X -At -U \"\$POSTGRES_USER\" -d $db -c \"SELECT 'inbound_messages', count(*) FROM inbound_messages UNION ALL SELECT 'n8n_chat_histories', count(*) FROM n8n_chat_histories UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations\""
done
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" app_restore_check'
```

This was run once against the local stack, with 5700000000-prefixed test rows seeded. Both databases counted 4 `inbound_messages`, 2 `n8n_chat_histories`, and 2 `schema_migrations` rows. The restore also kept every table's owner, `app`, along with the route `CHECK` and `app_runtime`'s grants.

To restore over `app` itself, stop n8n first, so nothing writes during the restore. `--clean --if-exists` drops each object in the dump before recreating it:

```bash
docker compose stop n8n
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d app --clean --if-exists --exit-on-error' < ~/cumbident-backups/app.dump
docker compose start n8n
```

Roles live at the server level, so a dump doesn't carry them; on a fresh volume, `db/init/` and `pnpm run db:migrate` recreate them from `.env`.

**n8n's own database** backs up the same way, with `-d n8n`. Its credentials are encrypted with `N8N_ENCRYPTION_KEY`, so keep that key, from `.env`, alongside the dump. A dump without the key restores workflows, but none of their credentials.

### 8. Connections

- **No published port.** `compose.yaml` publishes no Postgres port. Only containers on the Compose network reach it, and the dumps above go through `docker compose exec`.
- **Where credentials live.** Only in `.env`, which git ignores, and in n8n's credential store, which `N8N_ENCRYPTION_KEY` encrypts.
- **Authentication by path.** n8n connects over the Compose network, where `pg_hba.conf` requires `scram-sha-256`. Inside the `postgres` container, the local socket and loopback use the official image's `trust` default, which `db/init/`, `db-migrate`, and `check-db` rely on. Reaching that socket takes `docker exec`, and Docker access on the host is already root-equivalent.
- **No TLS on the network.** The credentials set `ssl: disable`, and the server runs with `ssl = off`. That's a limit of this local, single-host demo.
- **What production would need:**
  - TLS with a CA-signed server certificate, and the client verifying it (`sslmode=verify-full`);
  - Postgres on a private network or a managed service;
  - `pg_hba.conf` narrowed to n8n's own address;
  - no `trust` lines;
  - rotated passwords.

## Upgrading an existing local stack

These steps take a volume created before `db/migrations/` existed to the current state, without losing data. Never run `docker compose down -v`: the volume also holds n8n's own database, with its credentials and sign-ins.

1. **Pull the change.**
2. **Add the two new `.env` names.** `.env.example` shows them. Write the password straight into the file, so it never reaches the terminal:

   ```bash
   { echo; echo 'APP_RUNTIME_DB_USER=app_runtime'; printf 'APP_RUNTIME_DB_PASSWORD='; openssl rand -hex 32; } >> .env
   ```

   The leading `echo` keeps a `.env` without a final newline from running its last line into the first new one.

   Don't regenerate `.env` with `node scripts/init-env.ts` on an existing volume. It would replace `N8N_ENCRYPTION_KEY` and every role password, which locks n8n out of its credentials and its own database. If you skip this step, `pnpm run db:migrate` stops before it touches anything and names the missing variables.
3. **Start the stack with `docker compose up -d --wait`.** This recreates `postgres` with the two new variables in its environment. `db-migrate` doesn't depend on that, since it forwards the current `.env` values itself, but the service definition changed.
4. **Run `pnpm run setup`.** It applies `001_runtime_role.sql`, `002_route_check.sql`, and `003_received_at_index.sql`, sets `app_runtime`'s password, and imports the credentials. `App DB` now connects as `app_runtime`, and the new `App DB (chat memory)` connects as `app`. Then it publishes the workflows and restarts n8n.
5. **No credential refresh is needed.** `setup-credentials` re-imports every credential that isn't Google OAuth2 on every run. Only the Calendar, Sheets, and Gmail types are skipped when they already exist. After step 4, n8n's only session on `app` is `app_runtime`.
6. **Run `node scripts/check-db.ts`.** A second `pnpm run setup` prints `no pending migrations`.

## Proving it: `check-db`

`node scripts/check-db.ts` runs psql inside the `postgres` container, mostly as `app_runtime`, and prints `ok` or `FAIL` for each check. It exits 1 if any check fails. Each check has a unit-tested predicate in `tests/check-db.test.ts`.

| Check | Passes when |
|---|---|
| CREATE TABLE is denied | Postgres answers `permission denied for schema public` |
| DROP TABLE is denied, for each granted table | `must be owner of table …` |
| TRUNCATE is denied, for each granted table | `permission denied for table …` |
| connecting to the n8n database is denied | `permission denied for database "n8n"` |
| SET ROLE to the owner is denied | `permission denied to set role` |
| no role attribute, membership, column grant, or TEMP/CREATE on app beyond the grant list | Checked as the superuser: `app_runtime` holds none of `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, or `BYPASSRLS`; `pg_auth_members` lists it as a member of nothing; `has_any_column_privilege` finds no column privilege its table grants don't cover; and it has no `TEMP` or `CREATE` on `app` |
| table privileges are exactly the grant list | `app_runtime`'s privileges on every table and sequence in `public` equal `RUNTIME_GRANTS`: none missing, none extra |
| every workflow Postgres statement runs | all ten statements run as `app_runtime`, inside one transaction it rolls back |
| `schema_migrations` lists every file in `db/migrations` | every file is recorded |

- **What counts as a denial.** Only the expected one passes. A statement that succeeds fails the check, and so does psql failing for any other reason, such as a missing role or a stopped container.
- **Nothing persists.** Every statement that could change data runs inside `BEGIN … ROLLBACK`.
- **The statement check reads the workflows.** It runs each Postgres node's query straight from the workflow JSON. A unit test fails when a new Postgres node has no probe values in `PROBES`.
- **Two checks cover what `has_table_privilege` can't see.** The role-attribute check catches an attribute, a membership, or a column-level grant, since `has_table_privilege` only reports whole-table privileges. The `SET ROLE` denial catches a membership that would let the role act as the owner.

CI's `n8n` job runs `check-db` after `pnpm run setup` on a fresh volume. Then `check-dev-response.ts` drives `retention` and `check-availability` through n8n, which proves `app_runtime`'s grants hold for a real run.

To prove the check can fail, grant a forbidden privilege by hand as the superuser, then run it. Each of these makes `check-db` exit 1:

- `GRANT TRUNCATE ON inbound_messages TO app_runtime` fails "TRUNCATE inbound_messages is denied" and "table privileges are exactly the grant list".
- `ALTER ROLE app_runtime CREATEDB`, `GRANT INSERT (session_id) ON n8n_chat_histories TO app_runtime`, `GRANT TEMP ON DATABASE app TO app_runtime`, or `GRANT CREATE ON DATABASE app TO app_runtime` fails the role-attribute check. The table-privilege check misses all four.
- `GRANT app TO app_runtime` fails the role-attribute check and "SET ROLE to the owner is denied".

Revoke each one afterward. `pnpm run db:migrate` also resets the attributes on its own.
