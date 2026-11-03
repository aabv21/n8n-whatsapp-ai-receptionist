import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { buildWorkflows, hardenAgainstFrozenDefineProperty } from '../scripts/build-workflows.ts';
import { checkWorkflow } from '../scripts/check-workflows.ts';
import { normalizeWorkflow } from '../scripts/export-workflows.ts';
import { missingTriggerCredentials } from '../scripts/import-workflows.ts';
import { listJsonFiles, readWorkflow, type Workflow, type WorkflowNode } from '../scripts/lib/workflow.ts';
import { CREDENTIALS, LOAD_CONTEXT_ID } from '../scripts/manifest.ts';
import { buildCredentials, buildImportCall, EXPORT_SCRIPT, existingCredentialIds, IMPORT_SCRIPT, skipExisting } from '../scripts/setup-credentials.ts';
import { runGenerated } from './helpers/run-generated.ts';

const { composeMock } = vi.hoisted(() => ({ composeMock: vi.fn<(args: readonly string[], input?: string) => Promise<{ stdout: string; stderr: string }>>() }));
vi.mock('../scripts/lib/runtime.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), compose: composeMock }));

afterEach(() => {
  composeMock.mockReset();
});

const fx = (name: string): Workflow => readWorkflow(`tests/fixtures/workflows/${name}.json`);
const opts = { credentialIds: new Set(CREDENTIALS.map((c) => c.id)), generatedNodes: new Set(['Double value']) };
const errors = (wf: Workflow): string => checkWorkflow(wf, opts).join('\n');
const withNode = (node: WorkflowNode): Workflow => ({ ...fx('clean'), nodes: [...fx('clean').nodes, node] });
const fullEnv = Object.fromEntries(CREDENTIALS.flatMap((c) => c.env).map((k) => [k, `${k.toLowerCase()}-test`]));
const entry = { file: 'clean.json', node: 'Double value', source: 'tests/fixtures/nodes/double-value.ts', why: 'fixture' };
const tempCopy = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cmb-'));
  cpSync('tests/fixtures/workflows/clean.json', join(dir, 'clean.json'));
  return dir;
};
const built = async (): Promise<string> => {
  const dir = tempCopy();
  await buildWorkflows({ dir, entries: [entry], write: true });
  return String(readWorkflow(join(dir, 'clean.json')).nodes.find((n) => n.name === 'Double value')?.parameters.jsCode);
};

test('clean workflow passes', () => expect(checkWorkflow(fx('clean'), opts)).toEqual([]));
test('pinned data is rejected', () => expect(errors(fx('pinned'))).toMatch(/pinData present/));
test('literal email, phone, long id and secret are rejected', () => {
  for (const m of [/literal email/, /literal phone/, /literal long id/, /secret-like value/]) expect(errors(fx('leaky'))).toMatch(m);
});
test('unknown credential is rejected', () => expect(errors(fx('bad-credential'))).toMatch(/credential nope not in manifest/));
test('code node needs a Why Code line', () => expect(errors(fx('no-why'))).toMatch(/must start with \/\/ Why Code:/));
test('hand-written code node is rejected', () =>
  expect(checkWorkflow(fx('clean'), { ...opts, generatedNodes: new Set() }).join('\n'))
    .toMatch(/code node Double value is not generated from src\/nodes/));
test('required settings are enforced', () => {
  const e = errors({ ...fx('clean'), settings: { executionOrder: 'v0', timezone: 'UTC', callerPolicy: 'any', errorWorkflow: 'x' } });
  for (const m of [/executionOrder must be v1/, /timezone must be America\/Bogota/,
    /callerPolicy must be workflowsFromSameOwner/, /errorWorkflow must be cmbErrorHandler1/]) expect(e).toMatch(m);
});
test('the error handler is exempt from the errorWorkflow rule', () => {
  const wf = fx('clean');
  delete wf.settings.errorWorkflow;
  expect(checkWorkflow({ ...wf, id: 'cmbErrorHandler1' }, opts)).toEqual([]);
});
test('the context loader is exempt from the errorWorkflow rule', () => {
  const wf = fx('clean');
  delete wf.settings.errorWorkflow;
  expect(checkWorkflow({ ...wf, id: LOAD_CONTEXT_ID }, opts)).toEqual([]);
});
test('a workflow that is neither the error handler nor the context loader still needs an errorWorkflow', () => {
  const wf = fx('clean');
  delete wf.settings.errorWorkflow;
  expect(errors(wf)).toMatch(/errorWorkflow must be cmbErrorHandler1/);
});
test('explicit null counts as missing', () =>
  expect(errors({ ...fx('clean'), connections: null } as unknown as Workflow)).toMatch(/missing connections/));
test('external call without retry is rejected', () =>
  expect(errors(withNode({ name: 'Read sheet', type: 'n8n-nodes-base.googleSheets', typeVersion: 4, parameters: {} })))
    .toMatch(/node Read sheet calls an external service without retry on fail/));
test('expression inside SQL is rejected', () =>
  expect(errors(withNode({ name: 'Insert row', type: 'n8n-nodes-base.postgres', typeVersion: 2, retryOnFail: true,
    parameters: { operation: 'executeQuery', query: "SELECT '{{ $json.text }}'" } })))
    .toMatch(/query in node Insert row must use \$n parameters, not expressions/));
test('normalize drops volatile fields and is idempotent', () => {
  const n = normalizeWorkflow(fx('volatile'));
  expect([n.pinData, n.versionId, n.active, n.versionCounter, (n.meta as { instanceId?: string } | undefined)?.instanceId])
    .toEqual([undefined, undefined, undefined, undefined, undefined]);
  expect(n.id).toBe(fx('volatile').id);
  expect(normalizeWorkflow(structuredClone(n))).toEqual(n);
});
test('credentials use the fixed ids', () => {
  const { credentials, skipped } = buildCredentials(fullEnv);
  expect(credentials.map((c) => c.id).sort()).toEqual(CREDENTIALS.map((c) => c.id).sort());
  expect(skipped).toEqual([]);
  expect(credentials.find((c) => c.id === 'cmbCredTypeSafe1')?.data.value).toBe('Bearer typesafe_api_key-test');
});
test('the Gmail credential asks Google only for permission to send', () => {
  // notify-team and error-handler only send, so the token can't read or delete the team's mail.
  const gmail = buildCredentials(fullEnv).credentials.filter((c) => c.type === 'gmailOAuth2');
  expect(gmail).toHaveLength(1);
  expect(gmail[0]?.data).toMatchObject({ customScopes: true, enabledScopes: 'https://www.googleapis.com/auth/gmail.send' });
});
test('credentials with missing env are skipped and named', () => {
  const { credentials, skipped } = buildCredentials({ APP_RUNTIME_DB_USER: 'u', APP_RUNTIME_DB_PASSWORD: 'p' });
  expect(credentials.map((c) => c.id)).toEqual(['cmbCredAppDb0001']);
  expect(skipped.find((s) => s.id === 'cmbCredAnthropic')?.missing).toContain('ANTHROPIC_API_KEY');
});
test('the app credential connects as the runtime role, and only the chat memory credential as the owner', () => {
  const { credentials } = buildCredentials(fullEnv);
  const user = (id: string): unknown => credentials.find((c) => c.id === id)?.data.user;
  expect(user('cmbCredAppDb0001')).toBe('app_runtime_db_user-test');
  expect(user('cmbCredChatMemDb')).toBe('app_db_user-test');
  const postgresCredentials = credentials.filter((c) => c.type === 'postgres').map((c) => c.id).sort();
  expect(postgresCredentials).toEqual(['cmbCredAppDb0001', 'cmbCredChatMemDb']);
});
test('only the Postgres Chat Memory node uses the owner credential', () => {
  const owners = listJsonFiles('workflows').flatMap((path) =>
    readWorkflow(path).nodes.filter((n) => n.credentials?.postgres?.id === 'cmbCredChatMemDb').map((n) => `${n.name} (${n.type})`));
  expect(owners).toEqual(['Postgres Chat Memory (@n8n/n8n-nodes-langchain.memoryPostgresChat)']);
});
test('only trigger credentials hold back publishing', () => {
  const trigger = withNode({ name: 'On message', type: 'n8n-nodes-base.whatsAppTrigger', typeVersion: 1, parameters: {},
    credentials: { whatsAppTriggerApi: { id: 'cmbCredWaTrigger', name: 'WhatsApp trigger' } } });
  const mailer = withNode({ name: 'Send email', type: 'n8n-nodes-base.gmail', typeVersion: 2, retryOnFail: true, parameters: {},
    credentials: { gmailOAuth2: { id: 'cmbCredGmail0001', name: 'Gmail' } } });
  expect(missingTriggerCredentials(trigger, new Set())).toEqual(['cmbCredWaTrigger']);
  expect(missingTriggerCredentials(mailer, new Set())).toEqual([]);
});
test('a missing directory lists no files', () => expect(listJsonFiles('tests/fixtures/does-not-exist')).toEqual([]));
test('generated code runs like a Code node', async () =>
  expect(runGenerated(await built(), { n: 2 })).toEqual([{ json: { n: 4 } }]));
test('generated code still exports run when Object.defineProperty is frozen, like the real n8n Task Runner sandbox', async () => {
  // @n8n/task-runner's createVmExecutableCode runs Code-node JS after `Object.defineProperty = ()
  // => ({})`. esbuild's own export plumbing calls that function, so without
  // hardenAgainstFrozenDefineProperty, __node.run silently comes back undefined there.
  const hardened = `Object.defineProperty = () => ({});\n${await built()}`;
  expect(runGenerated(hardened, { n: 2 })).toEqual([{ json: { n: 4 } }]);
});
test('hardenAgainstFrozenDefineProperty rejects a bundle without the expected esbuild helper', () =>
  expect(() => hardenAgainstFrozenDefineProperty('var x = 1;')).toThrow(/esbuild output didn't contain/));
test('generated code carries the header and footer', async () => {
  const lines = (await built()).trimEnd().split('\n');
  expect(lines[0]).toBe('// Why Code: fixture. Generated from tests/fixtures/nodes/double-value.ts by pnpm run build:workflows; edit the source.');
  expect(lines.at(-1)).toBe('return [{ json: __node.run($input.first().json) }];');
});
test('check mode reports a stale node and write mode fixes it', async () => {
  const dir = tempCopy();
  expect((await buildWorkflows({ dir, entries: [entry], write: false })).stale).toEqual(['clean.json › Double value']);
  await buildWorkflows({ dir, entries: [entry], write: true });
  expect((await buildWorkflows({ dir, entries: [entry], write: false })).stale).toEqual([]);
});

// setup-credentials.ts must not silently overwrite a Google OAuth2 credential that
// already exists (import:credentials overwrites by id, which would wipe the owner's sign-in).
test('an existing Google OAuth2 credential is skipped unless forced', () => {
  const calendar = { id: 'cmbCredGCalendar', name: 'Google Calendar', type: 'googleCalendarOAuth2Api', data: {} };
  const appDb = { id: 'cmbCredAppDb0001', name: 'App DB', type: 'postgres', data: {} };
  const existing = new Set([calendar.id, appDb.id]);
  expect(skipExisting([calendar, appDb], existing, false)).toEqual({
    toImport: [appDb],
    alreadyExists: [{ id: calendar.id, name: calendar.name }],
  });
  expect(skipExisting([calendar, appDb], existing, true)).toEqual({ toImport: [calendar, appDb], alreadyExists: [] });
});

// On a Linux CI runner the import step used to fail: a credentials.json file written by the
// runner's own uid is unreadable by n8n's own, different uid inside the container. Streaming
// the JSON over stdin instead means buildImportCall's `input` is the only place the decrypted
// data appears — never a file argument, and never written to `.n8n-import/` at all.
test('the import call carries credentials only as stdin input, never as a file argument', () => {
  const appDb = { id: 'cmbCredAppDb0001', name: 'App DB', type: 'postgres', data: { password: 'secret' } };
  const { args, input } = buildImportCall([appDb]);
  expect(args).toEqual(['exec', '-T', 'n8n', 'sh', '-c', IMPORT_SCRIPT]);
  expect(args.join(' ')).not.toContain('secret');
  expect(args.join(' ')).not.toContain('.n8n-import');
  expect(input).toBe(JSON.stringify([appDb]));
});
test('the import script makes its own temp file, never touches .n8n-import, and exits with the import status', () => {
  expect(IMPORT_SCRIPT).toContain('umask 077');
  expect(IMPORT_SCRIPT).toContain('mktemp');
  expect(IMPORT_SCRIPT).toContain('cat > "$tmp"');
  expect(IMPORT_SCRIPT).toContain('n8n import:credentials --input="$tmp"');
  expect(IMPORT_SCRIPT).toContain('rm -f "$tmp"');
  expect(IMPORT_SCRIPT).toContain('exit $status');
  expect(IMPORT_SCRIPT).not.toContain('.n8n-import');
  expect(IMPORT_SCRIPT).not.toContain('/import');
});

test('EXPORT_SCRIPT sets a strict umask, uses its own temp file, sends n8n\'s own output to stderr, and only cats on success', () => {
  expect(EXPORT_SCRIPT).toContain('umask 077');
  expect(EXPORT_SCRIPT).toContain('mktemp');
  expect(EXPORT_SCRIPT).toContain('n8n export:credentials --all --output="$tmp" >&2');
  expect(EXPORT_SCRIPT).toContain('cat "$tmp"');
  expect(EXPORT_SCRIPT).toContain('rm -f "$tmp"');
  expect(EXPORT_SCRIPT).toContain('exit $status');
  expect(EXPORT_SCRIPT).not.toContain('.n8n-import');
});

test('existingCredentialIds runs EXPORT_SCRIPT and parses the ids from stdout, never a file', async () => {
  composeMock.mockResolvedValue({ stdout: JSON.stringify([{ id: 'cmbCredAppDb0001' }, { id: 'cmbCredGCalendar' }]), stderr: 'Acquiring database migration lock...\nSuccessfully exported 2 credentials.' });
  const ids = await existingCredentialIds();
  expect(composeMock).toHaveBeenCalledWith(['exec', '-T', 'n8n', 'sh', '-c', EXPORT_SCRIPT]);
  expect(ids).toEqual(new Set(['cmbCredAppDb0001', 'cmbCredGCalendar']));
});

test('existingCredentialIds returns an empty set when n8n reports no credentials yet, on either stream', async () => {
  composeMock.mockRejectedValueOnce(Object.assign(new Error('exit 1'), { stdout: '', stderr: 'No credentials found' }));
  expect(await existingCredentialIds()).toEqual(new Set());

  composeMock.mockRejectedValueOnce(Object.assign(new Error('exit 1'), { stdout: 'No credentials found', stderr: '' }));
  expect(await existingCredentialIds()).toEqual(new Set());
});

test('existingCredentialIds rethrows any other failure', async () => {
  composeMock.mockRejectedValueOnce(Object.assign(new Error('exit 1'), { stdout: '', stderr: 'permission denied' }));
  await expect(existingCredentialIds()).rejects.toThrow('exit 1');
});

test('existingCredentialIds throws a fixed message, not the unparseable export, when stdout is not JSON', async () => {
  const corruptStdout = 'Acquiring database migration lock...\n{"id":"cmbCredAppDb0001", truncated';
  composeMock.mockResolvedValue({ stdout: corruptStdout, stderr: '' });
  await expect(existingCredentialIds()).rejects.toThrow('could not parse the credential listing from n8n export:credentials');
  await expect(existingCredentialIds()).rejects.not.toThrow(/cmbCredAppDb0001|truncated|migration lock/);
});
