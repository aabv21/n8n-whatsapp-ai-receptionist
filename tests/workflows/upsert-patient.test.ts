import { DateTime } from 'luxon';
import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import { CODE_NODES } from '../../scripts/manifest.ts';
import { evaluateExpression } from '../helpers/run-expression.ts';

const wf = readWorkflow('workflows/upsert-patient.json');
const node = (name: string) => wf.nodes.find((n) => n.name === name);
const prepare = String(node('Prepare patient merge')?.parameters.jsonOutput);

const prepared = (timezone: string, now = DateTime.fromISO('2026-11-05T03:00:00Z')): Record<string, unknown> =>
  evaluateExpression(prepare, {
    nodes: { 'Receive patient update': { phone: '570000000001', status: 'inquiry' }, 'Load context': { business: { timezone } } },
    json: { name: 'Laura Gomez' },
    now,
  }) as Record<string, unknown>;

// The merge rules are unit-tested in tests/nodes/merge-patient.test.ts; this file checks the wiring.
test('Merge patient fields is the generated merge-patient node, fed by Prepare patient merge', () => {
  expect(CODE_NODES).toContainEqual(expect.objectContaining({ file: 'upsert-patient.json', node: 'Merge patient fields', source: 'src/nodes/merge-patient.ts' }));
  expect(node('Merge patient fields')?.type).toBe('n8n-nodes-base.code');
  const main = (name: string): string[] => ((wf.connections[name] as { main: { node: string }[][] }).main[0] ?? []).map((e) => e.node);
  expect(main('Look up existing patient')).toEqual(['Prepare patient merge']);
  expect(main('Prepare patient merge')).toEqual(['Merge patient fields']);
  expect(main('Merge patient fields')).toEqual(['Upsert patient row']);
});

test("Prepare patient merge hands over the update, the stored row, and today in business.timezone", () => {
  expect(prepared('America/Bogota')).toEqual({ update: { phone: '570000000001', status: 'inquiry' }, stored: { name: 'Laura Gomez' }, today: '2026-11-04' });
  expect(prepared('Asia/Tokyo').today).toBe('2026-11-05');
});
