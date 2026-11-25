import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import { nodesNotInsideTheirSticky, stickiesHaveOwnColors, stickySections } from '../helpers/sticky-sections.ts';

const wf = readWorkflow('workflows/dev-harness.json');
const node = (name: string) => wf.nodes.find((n) => n.name === name);

const SECTIONS: Record<string, string[]> = {
  '## Dev harness': ['Receive dev call', 'Route by target', 'Respond with result', 'Respond unknown target'],
  '## Platform targets': ['Call load-context', 'Call notify-team', 'Fail deliberately', 'Call triage-message', 'Call process-message', 'Call retention'],
  '## Tool targets': [
    'Call check-availability', 'Call upsert-patient', 'Load context for find-patient', 'Look up patient', 'Keep rows with phone', 'Wrap patient rows',
    'Call book-appointment', 'Call dev-cleanup',
  ],
};

test("sticky notes frame each section's nodes, each in its own color", () => {
  expect(stickySections(wf).map((s) => s.heading).sort()).toEqual(Object.keys(SECTIONS).sort());
  expect(nodesNotInsideTheirSticky(wf, SECTIONS)).toEqual([]);
  expect(stickiesHaveOwnColors(wf)).toBe(true);
});

test("dev-harness hands cleanup to dev-cleanup with the request's phone_prefix", () => {
  const route = (wf.connections['Route by target'] as { main: { node: string }[][] }).main;
  const rules = (node('Route by target')?.parameters.rules as { values: { outputKey: string }[] }).values;
  expect(route[rules.findIndex((rule) => rule.outputKey === 'cleanup')]?.map((e) => e.node)).toEqual(['Call dev-cleanup']);
  const call = node('Call dev-cleanup');
  expect(call?.type).toBe('n8n-nodes-base.executeWorkflow');
  expect((call?.parameters.workflowId as { value: string }).value).toBe('cmbDevCleanup001');
  expect((call?.parameters.workflowInputs as { value: Record<string, unknown> }).value).toEqual({ phone_prefix: '={{ $json.body.input.phone_prefix }}' });
  expect((wf.connections['Call dev-cleanup'] as { main: { node: string }[][] }).main[0]?.map((e) => e.node)).toEqual(['Respond with result']);
});

test('the harness holds no cleanup node of its own', () => {
  expect(wf.nodes.filter((n) => /cleanup|Delete|Tag |Collect |Count /.test(n.name)).map((n) => n.name)).toEqual(['Call dev-cleanup']);
});
