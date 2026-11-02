import { expect, test } from 'vitest';
import { listJsonFiles, readWorkflow } from '../../scripts/lib/workflow.ts';

// A manual execution (run from the editor) is saved by default, with every node's input and
// output. No workflow here may save one: most carry a patient's phone, name, or message text, or
// the dev harness's X-Dev-Token header, and even load-context and retention-cleanup start from a
// passthrough Execute Workflow Trigger whose callers send no input schema, so each receives its
// caller's whole item. docs/database.md explains why there's no per-workflow list.
const files = listJsonFiles('workflows');

test('workflows/ is not empty, so the check below covers something', () => {
  expect(files.length).toBeGreaterThan(0);
});

test.each(files)('%s never saves a manual execution', (file) => {
  expect(readWorkflow(file).settings.saveManualExecutions).toBe(false);
});
