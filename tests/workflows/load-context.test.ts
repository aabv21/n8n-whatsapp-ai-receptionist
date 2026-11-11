import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import { LOAD_CONTEXT_ID } from '../../scripts/manifest.ts';

const loadContext = readWorkflow('workflows/load-context.json');
const errorHandler = readWorkflow('workflows/error-handler.json');

// The error handler calls load-context, so load-context naming the handler as its own error
// workflow would loop the two forever whenever a context file is missing or unparseable.
test('load-context has no errorWorkflow of its own', () => {
  expect(loadContext.settings.errorWorkflow).toBeUndefined();
});

test('error-handler calls only load-context, and no sub-workflow that could call it back', () => {
  const calls = errorHandler.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.parameters.workflowId).toMatchObject({ value: LOAD_CONTEXT_ID });
});

type Edge = { node: string; index: number };
const outgoing = (name: string): Edge[][] =>
  (loadContext.connections[name] as { main?: Edge[][] } | undefined)?.main ?? [];

/** Every `[source, inputIndex]` pair that feeds `target`, in input order. */
function inputsOf(target: string): [string, number][] {
  const edges: [string, number][] = [];
  for (const source of Object.keys(loadContext.connections)) {
    for (const branch of outgoing(source)) {
      for (const edge of branch) if (edge.node === target) edges.push([source, edge.index]);
    }
  }
  return edges.sort((a, b) => a[1] - b[1]);
}

// A read that ever returned no item would leave its branch, the Merge, and the whole workflow with
// nothing, and the caller would carry on with no context; Always Output Data makes the parse step fail.
test('every file read sets Always Output Data and Execute Once, and feeds a parse step that throws on a missing file', () => {
  const reads = loadContext.nodes.filter((n) => n.type === 'n8n-nodes-base.readWriteFile');
  expect(reads).toHaveLength(4);
  for (const read of reads) {
    expect(read.alwaysOutputData, read.name).toBe(true);
    expect(read.executeOnce, read.name).toBe(true);
    const next = outgoing(read.name).flat();
    expect(next, read.name).toHaveLength(1);
    const parse = loadContext.nodes.find((n) => n.name === next[0]?.node);
    expect(parse?.type, read.name).toBe('n8n-nodes-base.extractFromFile');
  }
});

test('one four-input Merge combines the four parsed files by position', () => {
  const merges = loadContext.nodes.filter((n) => n.type === 'n8n-nodes-base.merge');
  expect(merges.map((n) => n.name)).toEqual(['Combine context']);
  expect(merges[0]?.parameters).toEqual({ mode: 'combine', combineBy: 'combineByPosition', numberInputs: 4 });
  expect(inputsOf('Combine context')).toEqual([
    ['Parse business facts', 0],
    ['Parse config settings', 1],
    ['Extract knowledge base text', 2],
    ['Extract system prompt text', 3],
  ]);
});

// Read/Write Files typeVersion 1 returns nothing for a missing file; from 1.1 it throws instead.
test('the reads stay on typeVersion 1.1, and the sticky note says a missing file fails the read', () => {
  for (const read of loadContext.nodes.filter((n) => n.type === 'n8n-nodes-base.readWriteFile')) {
    expect(read.typeVersion, read.name).toBeGreaterThanOrEqual(1.1);
  }
  const sticky = loadContext.nodes.find((n) => n.type === 'n8n-nodes-base.stickyNote');
  const content = String(sticky?.parameters.content);
  expect(content).toContain('No file(s) found');
  expect(content).toContain('Always Output Data');
});
