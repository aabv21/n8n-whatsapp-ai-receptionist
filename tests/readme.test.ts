import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const readme = readFileSync('README.md', 'utf8');
const conversations = JSON.parse(readFileSync('tests/scenarios/conversations.json', 'utf8')) as { id: string }[];
const config = JSON.parse(readFileSync('config/config.example.json', 'utf8')) as Record<string, unknown>;

/** The body of the README's `## <heading>` section, up to the next `## ` heading. */
const section = (heading: string): string => readme.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';

/** Every leaf key path in `value`, such as `limits.retention_days`. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

test('the README follows the design order', () => {
  const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(headings).toEqual([
    'Architecture',
    'What it does',
    'Status',
    'Quick start',
    'Configuration',
    'Test scenarios',
    'Cost per message',
    'Design decisions and production notes',
    'Limitations',
    'License',
  ]);
});

test('the quick start is five commands ending at a running demo', () => {
  const block = /```bash\n([\s\S]*?)```/.exec(section('Quick start'))?.[1] ?? '';
  const lines = block.trim().split('\n');
  expect(lines).toHaveLength(5);
  expect(lines.at(-1)).toBe('pnpm run setup');
});

test('the Test scenarios table lists every conversation', () => {
  const scenarios = section('Test scenarios');
  for (const { id } of conversations) expect(scenarios, id).toContain(`| \`${id}\` |`);
  expect(scenarios).toContain('`--tool-failure`');
});

test('Configuration names every Patients column in order', () => {
  expect(section('Configuration')).toContain('`last_contact | name | phone | service_of_interest | status | last_appointment`');
});

test('every config key the workflows read is documented', () => {
  const configuration = section('Configuration');
  const paths = new Set(leafPaths(config).map((path) => (path.startsWith('triage.thresholds.') ? 'triage.thresholds' : path)));
  for (const path of paths) expect(configuration, path).toContain(`\`${path}\``);
});

test('the live-check list is numbered and covers the checks only a live run can prove', () => {
  const live = section('Test scenarios').split('\n### Pending live checks\n')[1] ?? '';
  const items = live.split('\n').filter((line) => /^\d+\. /.test(line));
  expect(items).toHaveLength(27);
  expect(items.map((line) => Number(line.split('.')[0]))).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
  for (const text of ['jev-1.14.0', '--tool-failure', 'Workflow failed: Dev harness', 'too_many_bookings', '413', '+57 605 000 0000']) expect(live, text).toContain(text);
});

test('the quick start names its requirements and the first call to make', () => {
  const quick = section('Quick start');
  for (const text of ['Node 24', 'pnpm 11', 'Docker', "node scripts/dev-call.ts load-context '{}'"]) expect(quick, text).toContain(text);
});

test('the README links every diagram image', () => {
  for (const name of ['architecture', 'message-intake', 'message-reply', 'message-lifecycle', 'personal-data']) {
    expect(readme, name).toContain(`docs/diagrams/${name}.svg`);
  }
});

test('Limitations names the scope and the known gaps a client asks about', () => {
  const limits = section('Limitations');
  for (const text of ['`Create calendar event`', '`replied_at`', 'After a handoff', 'Scope: no appointment reminders']) expect(limits, text).toContain(text);
});
