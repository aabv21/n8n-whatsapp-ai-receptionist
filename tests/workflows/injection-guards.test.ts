import { expect, test } from 'vitest';
import { listJsonFiles, readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';

// These guards live only in node settings, which an edit in the n8n editor followed by
// `pnpm run export` could change without any other check noticing.
const nodes: { file: string; node: WorkflowNode }[] = listJsonFiles('workflows').flatMap((file) =>
  readWorkflow(file).nodes.map((node) => ({ file, node })));
const label = ({ file, node }: { file: string; node: WorkflowNode }): string => `${file} › ${node.name}`;

test('every Gmail node sends plain text, so text a patient typed cannot inject markup into a staff inbox', () => {
  const gmail = nodes.filter(({ node }) => node.type === 'n8n-nodes-base.gmail');
  expect(gmail.map(label).sort()).toEqual(['workflows/error-handler.json › Send failure email', 'workflows/notify-team.json › Send alert email']);
  for (const entry of gmail) expect(entry.node.parameters.emailType, label(entry)).toBe('text');
});

test('every Google Sheets write stores values raw, so a name like =HYPERLINK(...) stays text instead of becoming a formula', () => {
  const writes = nodes.filter(({ node }) =>
    node.type === 'n8n-nodes-base.googleSheets' && ['append', 'appendOrUpdate', 'update'].includes(String(node.parameters.operation)));
  expect(writes.length).toBeGreaterThan(0);
  for (const entry of writes) {
    expect((entry.node.parameters.options as { cellFormat?: unknown } | undefined)?.cellFormat, label(entry)).toBe('RAW');
  }
});
