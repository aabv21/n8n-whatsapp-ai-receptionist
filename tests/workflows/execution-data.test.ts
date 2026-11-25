import { expect, test } from 'vitest';
import { listJsonFiles, readWorkflow } from '../../scripts/lib/workflow.ts';

// A manual execution saves every node's input and output, and every workflow here can receive
// patient data or the dev token; docs/database.md explains why there's no per-workflow list.
const files = listJsonFiles('workflows');

test('workflows/ is not empty, so the check below covers something', () => {
  expect(files.length).toBeGreaterThan(0);
});

test.each(files)('%s never saves a manual execution', (file) => {
  expect(readWorkflow(file).settings.saveManualExecutions).toBe(false);
});

// n8n refuses to import a workflow in which two nodes share an id, so a hand-added node must get a fresh one.
test('every node id is unique within its workflow', () => {
  for (const path of listJsonFiles('workflows')) {
    const ids = readWorkflow(path).nodes.map((n) => n.id);
    const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicated, path).toEqual([]);
  }
});
