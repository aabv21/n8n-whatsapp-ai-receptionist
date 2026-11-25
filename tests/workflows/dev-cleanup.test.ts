import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import { CODE_NODES } from '../../scripts/manifest.ts';
import { evaluateExpression } from '../helpers/run-expression.ts';
import { nodesNotInsideTheirSticky, stickiesHaveOwnColors, stickySections } from '../helpers/sticky-sections.ts';

const wf = readWorkflow('workflows/dev-cleanup.json');
const node = (name: string) => wf.nodes.find((n) => n.name === name);

const SECTIONS: Record<string, string[]> = {
  '## cleanup: prefix guard': ['Receive cleanup request', 'Validate prefix', 'Refuse cleanup', 'Load context for cleanup'],
  '## cleanup: Calendar and Sheets': ['Search patient events', 'Delete patient event', 'List all patient rows', 'Delete matched rows', 'Count event outcomes', 'Count row outcomes'],
  '## cleanup: Postgres and result': ['Delete test messages', 'Delete test memories', 'Shape cleanup result'],
};

test("sticky notes frame each section's nodes, each in its own color", () => {
  expect(stickySections(wf).map((s) => s.heading).sort()).toEqual(Object.keys(SECTIONS).sort());
  expect(nodesNotInsideTheirSticky(wf, SECTIONS)).toEqual([]);
  expect(stickiesHaveOwnColors(wf)).toBe(true);
});

test('the trigger takes a phone_prefix string, and the workflow keeps manual executions off', () => {
  expect(node('Receive cleanup request')?.type).toBe('n8n-nodes-base.executeWorkflowTrigger');
  expect((node('Receive cleanup request')?.parameters.workflowInputs as { values: { name: string; type: string }[] }).values).toEqual([{ name: 'phone_prefix', type: 'string' }]);
  expect(wf.settings.saveManualExecutions).toBe(false);
});

// One request per call: .first() is always it, while .item would have to pair back through the
// Calendar and Sheets fan-out, which n8n can't always resolve.
test("the cleanup reads the request only through $('Receive cleanup request').first()", () => {
  for (const n of wf.nodes) {
    const parameters = JSON.stringify(n.parameters);
    expect(parameters, n.name).not.toContain("$('Receive cleanup request').item");
    expect(parameters, n.name).not.toContain('Receive dev call');
  }
  expect(JSON.stringify(node('Validate prefix')?.parameters)).toContain("$('Receive cleanup request').first().json.phone_prefix");
  expect(wf.nodes.filter((n) => JSON.stringify(n.parameters).includes("$('Receive cleanup request').first().json.phone_prefix")).length).toBe(5);
});

// A booking can sit as far ahead as config.limits.max_booking_days_ahead, so a fixed window would
// leave a test booking behind whenever the setting grows.
test('the cleanup Calendar search spans the booking horizon plus a day', () => {
  expect(node('Search patient events')?.parameters.timeMax).toBe(
    "={{ $now.plus({ days: $('Load context for cleanup').first().json.config.limits.max_booking_days_ahead + 1 }).toISO() }}",
  );
});

test('the cleanup sticky names the three inputs of each outcome Aggregate', () => {
  const content = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote').map((n) => String(n.parameters.content)).join('\n');
  expect(content).toContain('the search-failure tag');
});

test('the outcome counters are generated from count-cleanup-outcomes here, not in dev-harness', () => {
  for (const name of ['Count event outcomes', 'Count row outcomes']) {
    expect(CODE_NODES).toContainEqual(expect.objectContaining({ file: 'dev-cleanup.json', node: name, source: 'src/nodes/count-cleanup-outcomes.ts' }));
  }
});

// The guard that keeps a test cleanup from deleting real patients' Calendar events, sheet rows, and messages.
test('Validate prefix passes only 8 or more digits, and the refusal is prefix_too_short', () => {
  const condition = (node('Validate prefix')?.parameters.conditions as { conditions: { leftValue: string }[] }).conditions[0]?.leftValue ?? '';
  const passes = (phone_prefix: string): unknown => evaluateExpression(condition, { nodes: { 'Receive cleanup request': { phone_prefix } } });
  expect(passes('5700000000')).toBe(true);
  expect(passes('57000000')).toBe(true);
  for (const short of ['', '1', '5700000', '57000000x', '5700 0000', '________']) expect(passes(short), short).toBe(false);
  const connections = (wf.connections['Validate prefix'] as { main: { node: string }[][] }).main;
  expect(connections[0]?.map((e) => e.node)).toEqual(['Load context for cleanup']);
  expect(connections[1]?.map((e) => e.node)).toEqual(['Refuse cleanup']);
  expect(node('Refuse cleanup')?.parameters.jsonOutput).toContain('"reason": "prefix_too_short"');
});

test('both Postgres deletes match the prefix with starts_with, never LIKE, which a prefix of underscores would turn into a wildcard', () => {
  for (const name of ['Delete test messages', 'Delete test memories']) {
    const query = String(node(name)?.parameters.query);
    expect(query, name).toContain('starts_with(');
    expect(query, name).not.toMatch(/\bI?LIKE\b|~|SIMILAR TO/i);
  }
});
