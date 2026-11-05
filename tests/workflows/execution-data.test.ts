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
