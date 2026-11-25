import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingEnv, missingEnvError } from './lib/env.ts';
import { runMain } from './lib/errors.ts';
import { MIGRATION_NAME, MIGRATIONS_DIR, orderMigrations, pendingMigrations } from './lib/migrations.ts';
import { loadDotEnv, redact, runPsql, secretValues } from './lib/runtime.ts';
import { scanSql } from './lib/sql.ts';

/** psql's `\getenv psql_variable ENV_NAME`, the only way a migration reads `.env`. */
const GETENV = /^\\getenv[ \t]+\w+[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*$/gm;

/**
 * Runs before anything else, every time: creates the ledger of applied files (as the owner role,
 * so `app` owns it, not the superuser) and lists what it holds.
 */
export const BOOTSTRAP_SQL = `\\getenv owner APP_DB_USER
SET LOCAL ROLE :"owner";
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SELECT filename FROM schema_migrations ORDER BY filename;
`;

/**
 * Runs after the migrations, every time: `setup-credentials` rebuilds n8n's app credential from
 * `.env` on every run, so the role's password must follow `.env` on every run too, or a changed
 * value would lock n8n out. psql quotes the value itself; it never reaches an argument list.
 *
 * Postgres logs a failed statement's full text by default (`log_min_error_statement = error`),
 * and this one carries the password, so the transaction raises that threshold first, and turns
 * statement logging off in case a server enables it. The same statement re-asserts the role's
 * attributes, so a hand-granted `CREATEDB` or `SUPERUSER` doesn't survive the next run.
 */
export const RUNTIME_PASSWORD_SQL = `SET LOCAL log_min_error_statement = panic;
SET LOCAL log_statement = 'none';
\\getenv runtime_role APP_RUNTIME_DB_USER
\\getenv runtime_password APP_RUNTIME_DB_PASSWORD
ALTER ROLE :"runtime_role" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';
`;

/** Any fixed key: every run takes the same transaction-scoped advisory lock, so two runs can't interleave one file. */
export const MIGRATION_LOCK_KEY = 4_210_001;

/** The variables naming the other roles, which the runtime role must never share a name with. */
const OTHER_ROLE_NAMES = ['POSTGRES_USER', 'N8N_DB_USER', 'APP_DB_USER'] as const;

/** Every environment variable `sql` reads with `\getenv`, once each, in order. */
export function requiredEnv(sql: string): string[] {
  return [...new Set([...sql.matchAll(GETENV)].map((match) => match[1] ?? ''))];
}

/**
 * The variables in `OTHER_ROLE_NAMES` whose value equals `APP_RUNTIME_DB_USER`'s. Sharing a name
 * would point the runtime role's grants and password at the owner or the superuser instead.
 */
export function runtimeRoleClashes(env: Readonly<Record<string, string | undefined>>): string[] {
  const runtime = env.APP_RUNTIME_DB_USER;
  // eslint-disable-next-line security/detect-object-injection -- name is one of the fixed OTHER_ROLE_NAMES
  return runtime ? OTHER_ROLE_NAMES.filter((name) => env[name] === runtime) : [];
}

/**
 * The first transaction-control statement in `sql` (`BEGIN`, `COMMIT`, `ROLLBACK`, `ABORT`,
 * `START TRANSACTION`, or `END`), or `undefined`. A migration runs inside db-migrate's own
 * transaction, together with its ledger row, so one of these would split the two.
 */
export function transactionControl(sql: string): string | undefined {
  for (const statement of scanSql(sql).code.split(';')) {
    const keyword = /^\s*(BEGIN|COMMIT|ROLLBACK|ABORT|START\s+TRANSACTION|END)\b/i.exec(statement)?.[1];
    if (keyword) return keyword.toUpperCase().replace(/\s+/, ' ');
  }
  return undefined;
}

/** The statement that records `file` as applied, appended to the file so both commit together. */
export function recordMigration(file: string): string {
  if (!MIGRATION_NAME.test(file)) throw new Error(`${file} is not a migration file name`);
  return `INSERT INTO schema_migrations (filename) VALUES ('${file}');\n`;
}

/** What one psql run sends for `file`: the advisory lock first, then the file, then its ledger row. */
export function migrationScript(file: string, sql: string): string {
  return `SELECT pg_advisory_xact_lock(${String(MIGRATION_LOCK_KEY)});\n${sql}\n${recordMigration(file)}`;
}

/** Runs `sql` as the superuser in one transaction, failing with psql's own error, redacted. */
async function apply(label: string, sql: string): Promise<string> {
  const result = await runPsql({ role: 'POSTGRES_USER', database: 'app', forwardEnv: requiredEnv(sql), singleTransaction: true }, sql);
  if (!result.ok) throw new Error(`${label} failed, and nothing in it was applied:\n${redact(result.stderr.trim(), secretValues(process.env))}`);
  return result.stdout;
}

function assertEnv(source: string, sql: string): void {
  const missing = missingEnv(requiredEnv(sql), process.env);
  if (missing.length > 0) throw missingEnvError(source, missing);
}

async function main(): Promise<void> {
  loadDotEnv();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- MIGRATIONS_DIR is this repo's own fixed directory
  const files = orderMigrations(readdirSync(MIGRATIONS_DIR));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- file is a validated name read from MIGRATIONS_DIR
  const sql = new Map(files.map((file) => [file, readFileSync(join(MIGRATIONS_DIR, file), 'utf8')]));
  for (const [file, text] of sql) {
    const keyword = transactionControl(text);
    if (keyword) throw new Error(`${MIGRATIONS_DIR}/${file} contains ${keyword}; db-migrate runs each file in its own transaction`);
  }

  assertEnv('db-migrate', BOOTSTRAP_SQL + RUNTIME_PASSWORD_SQL);
  const clashes = runtimeRoleClashes(process.env);
  if (clashes.length > 0) throw new Error(`APP_RUNTIME_DB_USER must name its own role, but it matches ${clashes.join(', ')} in .env`);
  const applied = new Set((await apply('db-migrate bootstrap', BOOTSTRAP_SQL)).split('\n').filter(Boolean));
  const pending = pendingMigrations(files, applied);
  // Check every pending file before applying any, so a missing variable can't stop a run halfway.
  for (const file of pending) assertEnv(file, sql.get(file) ?? '');

  for (const file of pending) {
    await apply(file, migrationScript(file, sql.get(file) ?? ''));
    console.log(`applied ${file}`);
  }
  if (pending.length === 0) console.log('no pending migrations');

  await apply('setting the runtime role password', RUNTIME_PASSWORD_SQL);
  console.log('runtime role password set from APP_RUNTIME_DB_PASSWORD');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMain(main);
}
