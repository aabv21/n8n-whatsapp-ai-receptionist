import { expect, test } from 'vitest';
import { listJsonFiles, readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';
import { CREDENTIALS } from '../../scripts/manifest.ts';

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

test('no Gmail node sets a sender name while the Gmail credential may only send', () => {
  // n8n's Gmail node (checked against n8n `2.45.7` on 2026-11-11) reads GET users/me/profile to build the From header whenever
  // options.senderName is set, and gmail.send doesn't authorize that read, so every send would
  // fail with a 403. The display name comes from the Google account instead.
  const credential = CREDENTIALS.find((c) => c.type === 'gmailOAuth2');
  const data = credential?.data({}) ?? {};
  const sendOnly = data.customScopes === true && data.enabledScopes === 'https://www.googleapis.com/auth/gmail.send';
  const gmail = nodes.filter(({ node }) => node.type === 'n8n-nodes-base.gmail');
  expect(gmail.length).toBeGreaterThan(0);
  const withSenderName = gmail
    .filter(({ node }) => (node.parameters.options as { senderName?: unknown } | undefined)?.senderName !== undefined)
    .map(label);
  expect(sendOnly ? withSenderName : []).toEqual([]);
});

test('every Google Sheets write stores values raw, so a name like =HYPERLINK(...) stays text instead of becoming a formula', () => {
  const writes = nodes.filter(({ node }) =>
    node.type === 'n8n-nodes-base.googleSheets' && ['append', 'appendOrUpdate', 'update'].includes(String(node.parameters.operation)));
  expect(writes.length).toBeGreaterThan(0);
  for (const entry of writes) {
    expect((entry.node.parameters.options as { cellFormat?: unknown } | undefined)?.cellFormat, label(entry)).toBe('RAW');
  }
});
