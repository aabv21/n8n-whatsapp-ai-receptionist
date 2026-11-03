import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';

const wf = readWorkflow('workflows/check-availability.json');
const getBusyEvents = wf.nodes.find((n) => n.name === 'Get busy events');

test('Get busy events calls the Google Calendar node', () => expect(getBusyEvents?.type).toBe('n8n-nodes-base.googleCalendar'));

test("Get busy events expands recurring events into the queried day's own occurrence", () => {
  // The Calendar API needs singleEvents on. At this node's typeVersion (1.3) that field is hidden in
  // favor of Recurring Event Handling (confirmed with get_node); "expand" is what actually sends
  // singleEvents: true to the Calendar API. Without it, a recurring block (e.g. a daily lunch
  // hold) comes back as its unexpanded master event, anchored to its first occurrence, so the
  // overlap check in compute-free-slots.ts would miss it on every later occurrence.
  const options = getBusyEvents?.parameters.options as Record<string, unknown> | undefined;
  expect(options?.recurringEventHandling).toBe('expand');
});
