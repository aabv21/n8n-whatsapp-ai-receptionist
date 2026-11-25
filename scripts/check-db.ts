import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingEnv, missingEnvError } from './lib/env.ts';
import { MIGRATIONS_DIR, orderMigrations, pendingMigrations } from './lib/migrations.ts';
import { loadDotEnv, runPsql, type PsqlOptions, type PsqlResult } from './lib/runtime.ts';
import { listJsonFiles, readWorkflow, type Workflow } from './lib/workflow.ts';
import { runMain } from './lib/errors.ts';

/** What the runtime role may do, table by table: exactly what `001_runtime_role.sql` grants. */
export const RUNTIME_GRANTS: Readonly<Record<string, readonly string[]>> = {
  inbound_messages: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  n8n_chat_histories: ['SELECT', 'DELETE'],
};

/**
 * True only when psql failed with `message` — the denial a check expects. A statement that
 * succeeded, or psql failing for another reason (a missing role, a stopped container), is not a
 * denial, so neither can pass.
 */
export function isDenied(result: PsqlResult, message: string): boolean {
  return !result.ok && result.stderr.includes(message);
}

/** `expected` as `table:PRIVILEGE` entries, compared with `actual`: what the role lacks, and what it holds beyond the list. */
export function diffGrants(expected: Readonly<Record<string, readonly string[]>>, actual: readonly string[]): { missing: string[]; extra: string[] } {
  const want = new Set(Object.entries(expected).flatMap(([table, privileges]) => privileges.map((p) => `${table}:${p}`)));
  const have = new Set(actual);
  return {
    missing: [...want].filter((grant) => !have.has(grant)).sort(),
    extra: [...have].filter((grant) => !want.has(grant)).sort(),
  };
}

/**
 * What `ROLE_FACTS_SQL` reports about the runtime role, as problems: an attribute it holds, a role
 * it's a member of, a column-level privilege its table grants don't account for, or `TEMP` or
 * `CREATE` on `app`. An empty list means the role is as narrow as the grant list says. None of
 * these show up in `has_table_privilege`, which only sees whole-table privileges.
 */
export function roleProblems(facts: readonly string[], grants: Readonly<Record<string, readonly string[]>>): string[] {
  if (!facts.includes('role exists')) return ['the runtime role does not exist'];
  const problems: string[] = [];
  for (const fact of facts) {
    const [kind = '', subject = '', privilege = ''] = fact.split(':');
    if (kind === 'attribute') problems.push(`holds ${subject}`);
    else if (kind === 'member of') problems.push(`is a member of ${subject}`);
    // eslint-disable-next-line security/detect-object-injection -- subject is a table name Postgres reported, looked up in the fixed grant list
    else if (kind === 'column' && !(grants[subject] ?? []).includes(privilege)) problems.push(`has ${privilege} on columns of ${subject}`);
    else if (kind === 'temp on app') problems.push('has TEMP on app');
    else if (kind === 'create on app') problems.push('has CREATE on app');
  }
  return problems;
}

export interface WorkflowStatement {
  file: string;
  node: string;
  query: string;
}

/** Every Postgres node's query in `workflows`. Throws on a Postgres node that isn't a plain query, which `PROBES` couldn't run. */
export function workflowStatements(workflows: readonly { file: string; wf: Workflow }[]): WorkflowStatement[] {
  return workflows.flatMap(({ file, wf }) =>
    wf.nodes
      .filter((node) => node.type === 'n8n-nodes-base.postgres')
      .map((node) => {
        const { operation, query } = node.parameters;
        if (operation !== 'executeQuery' || typeof query !== 'string') {
          throw new Error(`${file} › ${node.name}: check-db can only run an Execute Query node's own SQL`);
        }
        return { file, node: node.name, query };
      }),
  );
}

/** The highest `$n` `query` references: how many values it binds. */
export function paramCount(query: string): number {
  return Math.max(0, ...[...query.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
}

/** `value` quoted for a psql meta-command such as `\bind`. */
export function psqlLiteral(value: string): string {
  if (value.includes('\\')) throw new Error(`${value}: a backslash would be read as an escape`);
  return `'${value.replaceAll("'", "''")}'`;
}

export interface Probe {
  file: string;
  node: string;
  params: readonly string[];
}

const PROBE_ID = 'check-db-probe';
const PROBE_PHONE = '570000000099';

/**
 * One set of values per workflow statement, run in this order: the insert first, so the updates
 * after it have a row to touch. The whole run is rolled back, so the values never persist.
 */
export const PROBES: readonly Probe[] = [
  { file: 'process-message.json', node: 'Record inbound message', params: [PROBE_ID, 'test', PROBE_PHONE, 'check-db probe', '2026-01-01T00:00:00Z'] },
  { file: 'process-message.json', node: 'Check handoff pause', params: [PROBE_PHONE, PROBE_ID, '12'] },
  { file: 'process-message.json', node: 'Count recent messages', params: [PROBE_PHONE, '10'] },
  { file: 'process-message.json', node: 'Recent conversation', params: ['test:' + PROBE_PHONE] },
  { file: 'process-message.json', node: 'Recent patient messages', params: [PROBE_PHONE, 'check-db-other'] },
  { file: 'process-message.json', node: 'Save triage', params: [PROBE_ID, '{"scores":null}'] },
  { file: 'process-message.json', node: 'Save route', params: [PROBE_ID, 'agent'] },
  { file: 'notify-team.json', node: 'Check alert cooldown', params: [PROBE_PHONE, '60', 'emergency', '5', '6'] },
  { file: 'notify-team.json', node: 'Mark team alerted', params: [PROBE_ID, 'emergency'] },
  { file: 'whatsapp-entry.json', node: 'Mark replied', params: [PROBE_ID] },
  { file: 'retention-cleanup.json', node: 'Delete expired chat memory', params: ['30'] },
  { file: 'retention-cleanup.json', node: 'Delete expired messages', params: ['30'] },
  { file: 'dev-cleanup.json', node: 'Delete test memories', params: [PROBE_PHONE] },
  { file: 'dev-cleanup.json', node: 'Delete test messages', params: [PROBE_PHONE] },
];

const label = (s: { file: string; node: string }): string => `${s.file} › ${s.node}`;

/**
 * A psql script that runs every statement exactly as its workflow wrote it, with `\bind` supplying
 * the `$n` values, inside one transaction it rolls back. `\warn` names each statement on stderr
 * first, so a failure shows which node's grant is missing.
 */
export function probeScript(statements: readonly WorkflowStatement[], probes: readonly Probe[]): string {
  for (const statement of statements) {
    if (!probes.some((probe) => label(probe) === label(statement))) throw new Error(`${label(statement)} has no probe in PROBES`);
  }
  const lines = ['BEGIN;'];
  for (const probe of probes) {
    const statement = statements.find((s) => label(s) === label(probe));
    if (!statement) throw new Error(`${label(probe)} matches no Postgres node in workflows/`);
    const expected = paramCount(statement.query);
    if (probe.params.length !== expected) throw new Error(`${label(probe)} takes ${String(expected)} values, but its probe has ${String(probe.params.length)}`);
    lines.push(`\\warn ${psqlLiteral(label(probe))}`, statement.query.trim().replace(/;$/, ''), `\\bind ${probe.params.map(psqlLiteral).join(' ')} \\g /dev/null`);
  }
  lines.push('ROLLBACK;');
  return `${lines.join('\n')}\n`;
}

/** What `behaviorScript` prints: the first insert, the same message_id again, a second message inside the window, then the window count. */
export const BEHAVIOR_EXPECTED: readonly string[] = ['1', '0', '1', '1'];
const BEHAVIOR_PHONE = '570000000098';

/**
 * A psql script that checks what two statements do, beyond running: "Record inbound message"
 * inserts a `message_id` once, and "Count recent messages" counts only the window. It binds the
 * workflows' own SQL, prints one value per call, and rolls everything back.
 */
export function behaviorScript(statements: readonly WorkflowStatement[]): string {
  const find = (node: string): string => {
    const statement = statements.find((s) => s.file === 'process-message.json' && s.node === node);
    if (!statement) throw new Error(`process-message.json › ${node} is missing, so check-db cannot probe its behavior`);
    return statement.query.trim().replace(/;$/, '');
  };
  const insert = find('Record inbound message');
  const count = find('Count recent messages');
  const bind = (...params: string[]): string => `\\bind ${params.map(psqlLiteral).join(' ')} \\g`;
  const old = ['check-db-behavior-a', 'test', BEHAVIOR_PHONE, 'behavior probe', '2026-01-01T00:00:00Z'] as const;
  return [
    '\\pset tuples_only on',
    '\\pset format unaligned',
    'BEGIN;',
    'SELECT now()::text AS probe_now \\gset',
    insert, bind(...old),
    insert, bind(...old),
    insert, "\\bind 'check-db-behavior-b' 'test' '570000000098' 'behavior probe' :'probe_now' \\g",
    count, bind(BEHAVIOR_PHONE, '10'),
    'ROLLBACK;',
  ].join('\n') + '\n';
}

/** `stdout` of `behaviorScript` compared with `BEHAVIOR_EXPECTED`, as one problem per mismatch. */
export function behaviorProblems(stdout: string): string[] {
  const got = stdout.split('\n').filter(Boolean);
  const names = ['insert 1 inserted', 'repeat insert', 'second insert', 'window count'];
  return BEHAVIOR_EXPECTED.flatMap((want, index) => {
    const have = got.at(index);
    return have === want ? [] : [`${names.at(index) ?? 'probe'} returned ${have ?? 'nothing'}, expected ${want}`];
  });
}

/**
 * What `handoffPauseScript` prints for "Check handoff pause": `paused|first_paused` for the first of
 * two messages that arrive in the same second, for the second, for a later one, and for a message
 * after a handoff whose agent run failed.
 */
export const HANDOFF_PAUSE_EXPECTED: readonly string[] = ['t|t', 't|f', 't|f', 't|t'];
const PAUSE_PHONE = '570000000097';
const PAUSE_PHONE_FAILED = '570000000096';

/** A psql helper shared by the behavior scripts: finds one statement's SQL, as its workflow wrote it. */
function findStatement(statements: readonly WorkflowStatement[], file: string, node: string): string {
  const statement = statements.find((s) => s.file === file && s.node === node);
  if (!statement) throw new Error(`${file} › ${node} is missing, so check-db cannot probe its behavior`);
  return statement.query.trim().replace(/;$/, '');
}

const bindValues = (...params: string[]): string => `\\bind ${params.map(psqlLiteral).join(' ')} \\g`;

/**
 * A psql script that checks what "Check handoff pause" decides, beyond running: a handoff inside the
 * window pauses, and exactly one message gets the first-paused line even when two arrive in the same
 * second, because the decision is a pure function of the recorded rows. It records a handoff, then
 * two in-flight messages with one timestamp, a later message after the first is saved, and a handoff
 * whose agent run failed (saved as `fallback`), all rolled back.
 */
export function handoffPauseScript(statements: readonly WorkflowStatement[]): string {
  const find = (file: string, node: string): string => findStatement(statements, file, node);
  const insert = find('process-message.json', 'Record inbound message');
  const saveRoute = find('process-message.json', 'Save route');
  const saveTriage = find('process-message.json', 'Save triage');
  const check = find('process-message.json', 'Check handoff pause');
  const record = (id: string, phone: string, at: string): string => `${insert}\n\\bind ${psqlLiteral(id)} 'test' ${psqlLiteral(phone)} 'pause probe' :'${at}' \\g`;
  return [
    '\\pset tuples_only on',
    '\\pset format unaligned',
    'BEGIN;',
    "SELECT (now() - interval '3 minutes')::text AS handoff_at, (now() - interval '2 minutes')::text AS burst_at, (now() - interval '1 minute')::text AS later_at \\gset",
    record('check-db-pause-a', PAUSE_PHONE, 'handoff_at'),
    saveRoute, bindValues('check-db-pause-a', 'handoff'),
    record('check-db-pause-b', PAUSE_PHONE, 'burst_at'),
    record('check-db-pause-c', PAUSE_PHONE, 'burst_at'),
    check, bindValues(PAUSE_PHONE, 'check-db-pause-b', '12'),
    check, bindValues(PAUSE_PHONE, 'check-db-pause-c', '12'),
    saveRoute, bindValues('check-db-pause-b', 'handoff_paused'),
    record('check-db-pause-d', PAUSE_PHONE, 'later_at'),
    check, bindValues(PAUSE_PHONE, 'check-db-pause-d', '12'),
    record('check-db-pause-e', PAUSE_PHONE_FAILED, 'handoff_at'),
    saveRoute, bindValues('check-db-pause-e', 'fallback'),
    saveTriage, bindValues('check-db-pause-e', '{"route":"handoff"}'),
    record('check-db-pause-f', PAUSE_PHONE_FAILED, 'burst_at'),
    check, bindValues(PAUSE_PHONE_FAILED, 'check-db-pause-f', '12'),
    'ROLLBACK;',
  ].join('\n') + '\n';
}

/** `stdout` of `handoffPauseScript` compared with `HANDOFF_PAUSE_EXPECTED`, as one problem per mismatch. */
export function handoffPauseProblems(stdout: string): string[] {
  // Each insert prints its own count; only the pause check's rows hold a `|`.
  const got = stdout.split('\n').filter((line) => line.includes('|'));
  const names = [
    'the first of two messages in the same second gets the line',
    'the second of two messages in the same second does not get the line',
    'a later message after a paused one does not get the line',
    'a handoff whose agent run failed still pauses',
  ];
  return HANDOFF_PAUSE_EXPECTED.flatMap((want, index) => {
    const have = got.at(index);
    return have === want ? [] : [`${names.at(index) ?? 'probe'} returned ${have ?? 'nothing'}, expected ${want}`];
  });
}

/**
 * What `cooldownScript` prints: the same reason held back, another reason and a first emergency not,
 * a second reason on the message, a repeat emergency inside its dedupe, outside a 0-minute dedupe,
 * a capped reason past a cap of 1, an emergency past that cap, then a failed emergency check, which is held
 * back like an emergency (only by a repeat inside the dedupe window) and never counts toward the cap, and
 * last a human request and a handoff re-alert, which no cap holds back either.
 */
export const COOLDOWN_EXPECTED: readonly string[] = ['t', 'f', 'f', 't', 't', 'f', 't', 'f', 'f', 't', 'f', 'f', 'f', 'f'];
const COOLDOWN_PHONE = '570000000095';

/**
 * A psql script that checks what notify-team's cooldown holds back: an alert is held back only by an
 * earlier alert of the same reason, the list keeps every reason marked on a message, an emergency is
 * held back only by an earlier emergency inside its short dedupe window, and the other reasons share
 * a per-phone hourly cap that never applies to an emergency, a failed emergency check, a human request, a complaint or a re-alert. It marks a `non_text` alert, asks for
 * `non_text`, `human_requested` and `emergency`, marks an `emergency` on the same message, and asks
 * again with the dedupe window and the cap set to values that prove each is read, all rolled back.
 */
export function cooldownScript(statements: readonly WorkflowStatement[]): string {
  const insert = findStatement(statements, 'process-message.json', 'Record inbound message');
  const mark = findStatement(statements, 'notify-team.json', 'Mark team alerted');
  const check = findStatement(statements, 'notify-team.json', 'Check alert cooldown');
  const ask = (reason: string, dedupeMinutes = '5', hourlyCap = '6'): string => `${check}\n${bindValues(COOLDOWN_PHONE, '60', reason, dedupeMinutes, hourlyCap)}`;
  return [
    '\\pset tuples_only on',
    '\\pset format unaligned',
    'BEGIN;',
    'SELECT now()::text AS cooldown_at \\gset',
    `${insert}\n\\bind 'check-db-cooldown' 'test' ${psqlLiteral(COOLDOWN_PHONE)} 'cooldown probe' :'cooldown_at' \\g`,
    mark, bindValues('check-db-cooldown', 'non_text'),
    ask('non_text'),
    ask('human_requested'),
    ask('emergency'),
    mark, bindValues('check-db-cooldown', 'emergency'),
    ask('non_text'),
    ask('emergency'),
    ask('emergency', '0'),
    ask('other', '5', '1'),
    ask('emergency', '0', '1'),
    ask('triage_failed', '5', '1'),
    mark, bindValues('check-db-cooldown', 'triage_failed'),
    ask('triage_failed'),
    ask('triage_failed', '0'),
    ask('human_requested', '5', '2'),
    ask('human_requested', '5', '1'),
    ask('handoff_followup', '5', '1'),
    'ROLLBACK;',
  ].join('\n') + '\n';
}

/** `stdout` of `cooldownScript` compared with `COOLDOWN_EXPECTED`, as one problem per mismatch. */
export function cooldownProblems(stdout: string): string[] {
  // Inserts print a count; the cooldown check prints `t` or `f`.
  const got = stdout.split('\n').filter((line) => line === 't' || line === 'f');
  const names = [
    'an alert of the same reason is held back',
    'an alert of another reason is not held back',
    'an emergency is not held back',
    'a reason stays held back after a second reason is marked on the message',
    'a repeat emergency inside the dedupe window is held back',
    'an emergency outside the dedupe window is not held back',
    'a capped reason past the hourly cap is held back',
    'an emergency past the hourly cap is not held back',
    'a failed emergency check past the hourly cap still alerts',
    'a repeat failed emergency check inside the dedupe window is held back',
    'a failed emergency check outside the dedupe window still alerts',
    'a failed emergency check does not count toward the hourly cap',
    'a human request past the hourly cap still alerts',
    'a handoff re-alert past the hourly cap still alerts',
  ];
  return COOLDOWN_EXPECTED.flatMap((want, index) => {
    const have = got.at(index);
    return have === want ? [] : [`${names.at(index) ?? 'probe'} returned ${have ?? 'nothing'}, expected ${want}`];
  });
}

/**
 * A psql script that proves the chat-memory shape "Recent conversation" reads: a human line, an ai
 * line with string content and an ai line whose content is blocks (only the `text` block may reach
 * the team). It inserts them as the owner, then runs the workflow's own SQL as the runtime role, and
 * rolls back.
 */
export function chatThreadScript(statements: readonly WorkflowStatement[]): string {
  const recent = findStatement(statements, 'process-message.json', 'Recent conversation');
  const line = (message: string): string => `('check-db-thread', ${psqlLiteral(message)}::jsonb)`;
  return [
    '\\getenv runtime_role APP_RUNTIME_DB_USER',
    '\\pset tuples_only on',
    '\\pset format unaligned',
    'BEGIN;',
    `INSERT INTO n8n_chat_histories (session_id, message) VALUES ${[
      line('{"type":"human","data":{"content":"Hola","additional_kwargs":{},"response_metadata":{}}}'),
      line('{"type":"ai","data":{"content":"Buenos días","tool_calls":[],"additional_kwargs":{},"response_metadata":{},"invalid_tool_calls":[]}}'),
      line('{"type":"ai","data":{"content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"Segunda"}],"tool_calls":[]}}'),
    ].join(', ')};`,
    'SET LOCAL ROLE :"runtime_role";',
    recent,
    bindValues('check-db-thread'),
    'ROLLBACK;',
  ].join('\n') + '\n';
}

/** What `chatThreadScript` must read back: the thread in order, with the block line reduced to its text. */
const CHAT_THREAD_EXPECTED = [
  { role: 'patient', text: 'Hola' },
  { role: 'assistant', text: 'Buenos días' },
  { role: 'assistant', text: 'Segunda' },
];

/** `stdout` of `chatThreadScript` compared with the expected thread, as at most one problem. */
export function chatThreadProblems(stdout: string): string[] {
  const row = stdout.split('\n').find((text) => text.startsWith('['));
  let thread: unknown;
  try {
    thread = JSON.parse(row ?? '');
  } catch {
    return [`the thread query printed no JSON array: ${row ?? 'nothing'}`];
  }
  return JSON.stringify(thread) === JSON.stringify(CHAT_THREAD_EXPECTED) ? [] : [`the thread read back as ${JSON.stringify(thread)}, expected ${JSON.stringify(CHAT_THREAD_EXPECTED)}`];
}

/** Every privilege the runtime role holds on a table or sequence in `public`, as `name:PRIVILEGE`. */
const GRANTS_SQL = `\\getenv runtime_role APP_RUNTIME_DB_USER
SELECT c.relname || ':' || p.privilege
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS p(privilege)
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND has_table_privilege(:'runtime_role', c.oid, p.privilege)
UNION ALL
SELECT c.relname || ':' || p.privilege
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)
WHERE n.nspname = 'public' AND c.relkind = 'S'
  AND has_sequence_privilege(:'runtime_role', c.oid, p.privilege)
ORDER BY 1;
`;

/** Facts about the runtime role that `roleProblems` judges: its attributes, memberships, column privileges, and `TEMP` on `app`. */
const ROLE_FACTS_SQL = `\\getenv runtime_role APP_RUNTIME_DB_USER
SELECT 'role exists' FROM pg_roles WHERE rolname = :'runtime_role'
UNION ALL
SELECT 'attribute:' || a.name
FROM pg_roles r
CROSS JOIN LATERAL (VALUES ('SUPERUSER', r.rolsuper), ('CREATEDB', r.rolcreatedb), ('CREATEROLE', r.rolcreaterole),
  ('REPLICATION', r.rolreplication), ('BYPASSRLS', r.rolbypassrls)) AS a(name, held)
WHERE r.rolname = :'runtime_role' AND a.held
UNION ALL
SELECT 'member of:' || m.roleid::regrole::text
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.member
WHERE r.rolname = :'runtime_role'
UNION ALL
SELECT 'column:' || c.relname || ':' || p.privilege
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(privilege)
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND has_any_column_privilege(:'runtime_role', c.oid, p.privilege)
UNION ALL
SELECT 'temp on app' WHERE has_database_privilege(:'runtime_role', 'app', 'TEMP')
UNION ALL
SELECT 'create on app' WHERE has_database_privilege(:'runtime_role', 'app', 'CREATE');
`;

interface Outcome {
  ok: boolean;
  detail?: string;
}

interface Check {
  name: string;
  run: () => Promise<Outcome>;
}

const asRuntime = (database: 'app' | 'n8n'): PsqlOptions => ({ role: 'APP_RUNTIME_DB_USER', database, forwardEnv: ['APP_RUNTIME_DB_USER', 'APP_DB_USER'], singleTransaction: false });
const AS_SUPERUSER: PsqlOptions = { role: 'POSTGRES_USER', database: 'app', forwardEnv: ['APP_RUNTIME_DB_USER'], singleTransaction: false };
const lines = (text: string): string[] => text.split('\n').filter(Boolean);
const lastLines = (text: string): string => lines(text).slice(-3).join(' | ');

function denial(name: string, database: 'app' | 'n8n', sql: string, message: string): Check {
  return {
    name,
    run: async () => {
      const result = await runPsql(asRuntime(database), sql);
      if (isDenied(result, message)) return { ok: true };
      return { ok: false, detail: result.ok ? 'it succeeded' : lastLines(result.stderr) };
    },
  };
}

function checks(statements: readonly WorkflowStatement[], migrationFiles: readonly string[]): Check[] {
  const tables = Object.keys(RUNTIME_GRANTS);
  return [
    denial('CREATE TABLE is denied', 'app', 'BEGIN;\nCREATE TABLE check_db_probe (id int);\nROLLBACK;\n', 'permission denied for schema public'),
    ...tables.flatMap((table) => [
      denial(`DROP TABLE ${table} is denied`, 'app', `BEGIN;\nDROP TABLE ${table};\nROLLBACK;\n`, `must be owner of table ${table}`),
      denial(`TRUNCATE ${table} is denied`, 'app', `BEGIN;\nTRUNCATE ${table};\nROLLBACK;\n`, `permission denied for table ${table}`),
    ]),
    denial('connecting to the n8n database is denied', 'n8n', 'SELECT 1;\n', 'permission denied for database "n8n"'),
    denial('SET ROLE to the owner is denied', 'app', '\\getenv owner APP_DB_USER\nSET ROLE :"owner";\n', 'permission denied to set role'),
    {
      name: 'no role attribute, membership, column grant, or TEMP/CREATE on app beyond the grant list',
      run: async () => {
        const result = await runPsql(AS_SUPERUSER, ROLE_FACTS_SQL);
        if (!result.ok) return { ok: false, detail: lastLines(result.stderr) };
        const problems = roleProblems(lines(result.stdout), RUNTIME_GRANTS);
        return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') };
      },
    },
    {
      name: 'table privileges are exactly the grant list',
      run: async () => {
        const result = await runPsql(AS_SUPERUSER, GRANTS_SQL);
        if (!result.ok) return { ok: false, detail: lastLines(result.stderr) };
        const { missing, extra } = diffGrants(RUNTIME_GRANTS, lines(result.stdout));
        if (missing.length === 0 && extra.length === 0) return { ok: true };
        return { ok: false, detail: [missing.length > 0 ? `missing ${missing.join(', ')}` : '', extra.length > 0 ? `extra ${extra.join(', ')}` : ''].filter(Boolean).join('; ') };
      },
    },
    {
      name: `every workflow Postgres statement runs (${String(statements.length)}, rolled back)`,
      run: async () => {
        const result = await runPsql(asRuntime('app'), probeScript(statements, PROBES));
        return result.ok ? { ok: true } : { ok: false, detail: lastLines(result.stderr) };
      },
    },
    {
      name: 'Record inbound message inserts a message_id once, and Count recent messages counts only the window (rolled back)',
      run: async () => {
        const result = await runPsql(asRuntime('app'), behaviorScript(statements));
        if (!result.ok) return { ok: false, detail: lastLines(result.stderr) };
        const problems = behaviorProblems(result.stdout);
        return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') };
      },
    },
    {
      name: 'Recent conversation reads a human line, an ai line and an ai line of blocks as the alert thread (rolled back)',
      run: async () => {
        const result = await runPsql(AS_SUPERUSER, chatThreadScript(statements));
        if (!result.ok) return { ok: false, detail: lastLines(result.stderr) };
        const problems = chatThreadProblems(result.stdout);
        return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') };
      },
    },
    {
      name: 'An alert is held back by the same reason, an emergency or failed check only by its dedupe window, and the rest by an hourly cap (rolled back)',
      run: async () => {
        const result = await runPsql(asRuntime('app'), cooldownScript(statements));
        if (!result.ok) return { ok: false, detail: lastLines(result.stderr) };
        const problems = cooldownProblems(result.stdout);
        return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') };
      },
    },
    {
      name: 'Check handoff pause pauses after a handoff, and one message in a same-second burst gets the line (rolled back)',
      run: async () => {
        const result = await runPsql(asRuntime('app'), handoffPauseScript(statements));
        if (!result.ok) return { ok: false, detail: lastLines(result.stderr) };
        const problems = handoffPauseProblems(result.stdout);
        return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join('; ') };
      },
    },
    {
      name: `schema_migrations lists every file in ${MIGRATIONS_DIR}`,
      run: async () => {
        const result = await runPsql({ ...AS_SUPERUSER, forwardEnv: [] }, 'SELECT filename FROM schema_migrations ORDER BY filename;\n');
        if (!result.ok) return { ok: false, detail: lastLines(result.stderr) };
        const unapplied = pendingMigrations(migrationFiles, new Set(lines(result.stdout)));
        return unapplied.length === 0 ? { ok: true } : { ok: false, detail: `not applied: ${unapplied.join(', ')}` };
      },
    },
  ];
}

async function main(): Promise<void> {
  loadDotEnv();
  const missing = missingEnv(['APP_RUNTIME_DB_USER', 'APP_DB_USER'], process.env);
  if (missing.length > 0) throw missingEnvError('check-db', missing);

  const statements = workflowStatements(listJsonFiles('workflows').map((path) => ({ file: basename(path), wf: readWorkflow(path) })));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- MIGRATIONS_DIR is this repo's own fixed directory
  const migrationFiles = orderMigrations(readdirSync(MIGRATIONS_DIR));

  let failed = 0;
  for (const check of checks(statements, migrationFiles)) {
    const { ok, detail } = await check.run();
    console.log(ok ? `ok    ${check.name}` : `FAIL  ${check.name}: ${detail ?? ''}`);
    if (!ok) failed++;
  }
  if (failed > 0) throw new Error(`${String(failed)} database check(s) failed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMain(main);
}
