import { expect, test } from 'vitest';
import { readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';

const wf = readWorkflow('workflows/retention-cleanup.json');
const node = (name: string): WorkflowNode | undefined => wf.nodes.find((n) => n.name === name);

type Edge = { node: string };
const branches = (name: string): Edge[][] => (wf.connections[name] as { main?: Edge[][] } | undefined)?.main ?? [];

/** Every `[source, branchIndex]` pair anywhere in the file whose branch lists `target`. */
function incomingEdges(target: string): [string, number][] {
  const edges: [string, number][] = [];
  for (const source of Object.keys(wf.connections)) {
    branches(source).forEach((branch, index) => {
      if (branch.some((e) => e.node === target)) edges.push([source, index]);
    });
  }
  return edges;
}

// Ruling P43: config.limits.retention_days must be validated before either DELETE runs. A missing,
// null, zero, or negative value would otherwise make `now() - make_interval(days => $1)` NULL (or
// a non-positive interval), which admits every row instead of none — wiping both tables.
test('"Delete expired chat memory" is reachable only from the retention-days guard\'s true output', () => {
  expect(incomingEdges('Delete expired chat memory')).toEqual([['Check retention days', 0]]);
});

test('"Delete expired messages" is reachable only from "Delete expired chat memory", not straight from Load context', () => {
  expect(incomingEdges('Delete expired messages')).toEqual([['Delete expired chat memory', 0]]);
});

test("the guard's false output stops the run instead of reaching either delete", () => {
  expect(branches('Check retention days')[1]?.map((e) => e.node)).toEqual(['Refuse invalid retention_days']);
  expect(node('Refuse invalid retention_days')?.type).toBe('n8n-nodes-base.stopAndError');
});

test('the guard failure names the exact bad config, so the error workflow email says what to fix', () => {
  expect(node('Refuse invalid retention_days')?.parameters.errorMessage)
    .toBe('config.limits.retention_days must be an integer of 1 or more');
});

test('both deletes always output data, so a zero-row DELETE cannot silently stop the run', () => {
  expect(node('Delete expired chat memory')?.alwaysOutputData).toBe(true);
  expect(node('Delete expired messages')?.alwaysOutputData).toBe(true);
});
