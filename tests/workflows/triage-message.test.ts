import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';

const wf = readWorkflow('workflows/triage-message.json');
const node = (name: string) => wf.nodes.find((n) => n.name === name);

// One of the two retry exceptions in the architecture doc: 2 tries x config.triage.timeout_ms plus one
// 1000 ms wait bound how long a slow TypeSafe delays a reply before triage fails open.
test('Score message with Jev makes 2 tries, 1000 ms apart, with config.triage.timeout_ms, and fails open through its error output', () => {
  const jev = node('Score message with Jev');
  expect([jev?.retryOnFail, jev?.maxTries, jev?.waitBetweenTries]).toEqual([true, 2, 1000]);
  expect((jev?.parameters.options as { timeout?: unknown }).timeout).toBe("={{ $('Load context').item.json.config.triage.timeout_ms }}");
  expect(jev?.onError).toBe('continueErrorOutput');
  const outputs = (wf.connections['Score message with Jev'] as { main: { node: string }[][] }).main;
  expect(outputs[1]?.map((e) => e.node)).toEqual(['Blank scores on Jev failure']);
});
