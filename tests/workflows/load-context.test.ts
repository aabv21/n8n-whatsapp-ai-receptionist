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
