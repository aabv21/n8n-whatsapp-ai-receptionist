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

const node = (name: string) => wf.nodes.find((n) => n.name === name);

// compute-free-slots refuses a day past the horizon as too_far, the reason book-appointment gives, and
// the date check returns it before any Calendar call.
test('both compute steps pass config.limits.max_booking_days_ahead, and too_far returns before Calendar', () => {
  expect(String(node('Prepare date check')?.parameters.jsonOutput)).toContain('max_booking_days_ahead: $json.config.limits.max_booking_days_ahead');
  expect(String(node('Prepare full compute')?.parameters.jsonOutput))
    .toContain("max_booking_days_ahead: $('Load context').item.json.config.limits.max_booking_days_ahead");
  const decide = node('Decide whether to call Calendar')?.parameters.conditions as { conditions: { leftValue: unknown }[] };
  expect(decide.conditions.map((c) => c.leftValue)).toEqual(["={{ $json.ok === false && $json.reason !== 'no_slots' }}"]);
});
