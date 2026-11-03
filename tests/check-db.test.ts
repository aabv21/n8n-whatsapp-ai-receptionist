import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  diffGrants,
  isDenied,
  paramCount,
  PROBES,
  probeScript,
  psqlLiteral,
  roleProblems,
  RUNTIME_GRANTS,
  workflowStatements,
  type WorkflowStatement,
} from '../scripts/check-db.ts';
import { listJsonFiles, readWorkflow } from '../scripts/lib/workflow.ts';

const failed = (stderr: string): { ok: false; stdout: string; stderr: string } => ({ ok: false, stdout: '', stderr });

describe('isDenied', () => {
  it('passes only when psql failed with the exact denial expected', () => {
    expect(isDenied(failed('psql:<stdin>:2: ERROR:  permission denied for schema public\nLINE 1: CREATE TABLE check_db_probe (id int);'), 'permission denied for schema public')).toBe(true);
  });

  it('fails when the statement succeeded, which is what an over-granted role looks like', () => {
    expect(isDenied({ ok: true, stdout: '', stderr: '' }, 'permission denied for schema public')).toBe(false);
  });

  it('fails when psql failed for another reason, so a missing role or a stopped container cannot pass as a denial', () => {
    expect(isDenied(failed('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "app_runtime" does not exist'), 'permission denied for database "n8n"')).toBe(false);
    expect(isDenied(failed('service "postgres" is not running'), 'must be owner of table inbound_messages')).toBe(false);
  });
});

describe('diffGrants', () => {
  it('finds nothing when the role holds exactly the listed privileges', () => {
    const actual = ['inbound_messages:DELETE', 'inbound_messages:INSERT', 'inbound_messages:SELECT', 'inbound_messages:UPDATE', 'n8n_chat_histories:DELETE', 'n8n_chat_histories:SELECT'];
    expect(diffGrants(RUNTIME_GRANTS, actual)).toEqual({ missing: [], extra: [] });
  });

  it('reports a privilege beyond the list, on a listed table or any other', () => {
    const actual = ['inbound_messages:DELETE', 'inbound_messages:INSERT', 'inbound_messages:SELECT', 'inbound_messages:TRUNCATE', 'inbound_messages:UPDATE',
      'n8n_chat_histories:DELETE', 'n8n_chat_histories:SELECT', 'schema_migrations:SELECT'];
    expect(diffGrants(RUNTIME_GRANTS, actual)).toEqual({ missing: [], extra: ['inbound_messages:TRUNCATE', 'schema_migrations:SELECT'] });
  });

  it('reports a listed privilege the role lacks', () => {
    expect(diffGrants(RUNTIME_GRANTS, ['inbound_messages:SELECT'])).toEqual({
      missing: ['inbound_messages:DELETE', 'inbound_messages:INSERT', 'inbound_messages:UPDATE', 'n8n_chat_histories:DELETE', 'n8n_chat_histories:SELECT'],
      extra: [],
    });
  });
});

describe('roleProblems', () => {
  it('finds nothing for a role with no attribute, no membership, and only column privileges its table grants cover', () => {
    const facts = ['column:inbound_messages:INSERT', 'column:inbound_messages:SELECT', 'column:inbound_messages:UPDATE', 'column:n8n_chat_histories:SELECT', 'role exists'];
    expect(roleProblems(facts, RUNTIME_GRANTS)).toEqual([]);
  });

  it('reports each attribute, membership, uncovered column privilege, TEMP on app, and CREATE on app', () => {
    const facts = ['attribute:CREATEDB', 'column:n8n_chat_histories:INSERT', 'column:schema_migrations:SELECT', 'member of:app', 'role exists', 'temp on app', 'create on app'];
    expect(roleProblems(facts, RUNTIME_GRANTS)).toEqual([
      'holds CREATEDB',
      'has INSERT on columns of n8n_chat_histories',
      'has SELECT on columns of schema_migrations',
      'is a member of app',
      'has TEMP on app',
      'has CREATE on app',
    ]);
  });

  it('reports a missing role instead of passing on an empty fact list', () => {
    expect(roleProblems([], RUNTIME_GRANTS)).toEqual(['the runtime role does not exist']);
  });
});

describe('paramCount', () => {
  it('is the highest $n a query references', () => {
    expect(paramCount('UPDATE inbound_messages SET route = $2 WHERE message_id = $1')).toBe(2);
    expect(paramCount("SELECT 'test:' || $1, $1")).toBe(1);
    expect(paramCount('SELECT 1')).toBe(0);
  });
});

describe('psqlLiteral', () => {
  it('quotes a value for a psql meta-command, doubling any single quote', () => {
    expect(psqlLiteral('{"scores":null}')).toBe(`'{"scores":null}'`);
    expect(psqlLiteral("it's")).toBe("'it''s'");
  });

  it('refuses a backslash, which psql would read as an escape inside a meta-command argument', () => {
    expect(() => psqlLiteral('a\\nb')).toThrow(/backslash/);
  });
});

describe('workflow statements', () => {
  const statements = workflowStatements(listJsonFiles('workflows').map((path) => ({ file: basename(path), wf: readWorkflow(path) })));
  const key = (s: { file: string; node: string }): string => `${s.file} › ${s.node}`;

  it('finds every Postgres query node in workflows/', () => {
    expect(statements.map(key).sort()).toEqual([
      'dev-harness.json › Delete test memories',
      'dev-harness.json › Delete test messages',
      'notify-team.json › Check alert cooldown',
      'notify-team.json › Mark team alerted',
      'process-message.json › Count recent messages',
      'process-message.json › Recent patient messages',
      'process-message.json › Record inbound message',
      'process-message.json › Save route',
      'process-message.json › Save triage',
      'retention-cleanup.json › Delete expired chat memory',
      'retention-cleanup.json › Delete expired messages',
      'whatsapp-entry.json › Mark replied',
    ]);
  });

  it('has exactly one probe per statement, with one value per $n, so a new Postgres node cannot skip the check', () => {
    expect(PROBES.map(key).sort()).toEqual(statements.map(key).sort());
    for (const probe of PROBES) {
      const statement = statements.find((s) => key(s) === key(probe));
      expect(probe.params, key(probe)).toHaveLength(paramCount(statement?.query ?? ''));
    }
  });

  it('runs every probe as the workflow wrote it, inside one transaction it rolls back', () => {
    const script = probeScript(statements, PROBES);
    const lines = script.trimEnd().split('\n');
    expect(lines[0]).toBe('BEGIN;');
    expect(lines.at(-1)).toBe('ROLLBACK;');
    for (const statement of statements) expect(script).toContain(`\n${statement.query}\n\\bind `);
    expect(script).toContain("\\warn 'process-message.json › Save route'\nUPDATE inbound_messages SET route = $2 WHERE message_id = $1\n\\bind 'check-db-probe' 'agent' \\g /dev/null");
  });

  it("probes notify-team's cooldown check and alert mark after the insert, so the mark has the probe's own row to update", () => {
    const order = PROBES.map(key);
    expect(order.indexOf('notify-team.json › Check alert cooldown')).toBeGreaterThan(order.indexOf('process-message.json › Record inbound message'));
    expect(order.indexOf('notify-team.json › Mark team alerted')).toBeGreaterThan(order.indexOf('process-message.json › Record inbound message'));
    expect(PROBES.find((p) => key(p) === 'notify-team.json › Mark team alerted')?.params).toEqual(['check-db-probe']);
    expect(PROBES.find((p) => key(p) === 'notify-team.json › Check alert cooldown')?.params).toEqual(['570000000099', '60']);
  });

  it('refuses a probe list that misses a statement', () => {
    const extra: WorkflowStatement = { file: 'new.json', node: 'New query', query: 'SELECT $1' };
    expect(() => probeScript([...statements, extra], PROBES)).toThrow(/new\.json › New query has no probe/);
  });
});
