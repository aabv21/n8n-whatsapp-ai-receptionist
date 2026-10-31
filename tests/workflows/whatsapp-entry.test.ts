import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';

const wf = readWorkflow('workflows/whatsapp-entry.json');
const node = (name: string) => wf.nodes.find((n) => n.name === name);

test('"Process message" runs once per WhatsApp Trigger item, so a batch never merges into one run', () => {
  expect(node('Process message')?.parameters.mode).toBe('each');
});

test('the WhatsApp send takes its recipient from Normalize message and its phone number id from the trigger', () => {
  const send = node('Send WhatsApp reply');
  expect(send?.parameters.recipientPhoneNumber).toBe("={{ $('Normalize message').item.json.phone }}");
  expect(send?.parameters.phoneNumberId).toBe("={{ $('Receive WhatsApp message').item.json.metadata.phone_number_id }}");
});

test('"Mark replied" only runs after the WhatsApp send succeeds', () => {
  const send = wf.connections['Send WhatsApp reply'] as { main?: { node: string }[][] } | undefined;
  expect(send?.main?.[0]?.map((c) => c.node)).toEqual(['Mark replied']);
  expect(send?.main?.[1] ?? []).toEqual([]);
});
