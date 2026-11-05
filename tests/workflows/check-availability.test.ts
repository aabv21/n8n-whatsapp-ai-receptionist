import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';

const wf = readWorkflow('workflows/check-availability.json');
const getBusyEvents = wf.nodes.find((n) => n.name === 'Get busy events');

test('Get busy events calls the Google Calendar node', () => expect(getBusyEvents?.type).toBe('n8n-nodes-base.googleCalendar'));

test("Get busy events expands recurring events into the queried day's own occurrence", () => {
  // At this node's typeVersion (1.3), singleEvents is hidden behind Recurring Event Handling, and
  // "expand" is what sends singleEvents: true. Without it, a recurring hold comes back as its master
  // event, anchored to its first occurrence, so compute-free-slots.ts misses every later one.
  const options = getBusyEvents?.parameters.options as Record<string, unknown> | undefined;
  expect(options?.recurringEventHandling).toBe('expand');
});
