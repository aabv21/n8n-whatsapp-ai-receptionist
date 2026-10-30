import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';

const wf = readWorkflow('workflows/book-appointment.json');
const recheckSlot = wf.nodes.find((n) => n.name === 'Recheck slot availability');

test('Recheck slot availability calls the Google Calendar node', () =>
  expect(recheckSlot?.type).toBe('n8n-nodes-base.googleCalendar'));

test("Recheck slot availability expands recurring events into the queried slot's own occurrence", () => {
  // Same reasoning as check-availability.test.ts: at this node's typeVersion (1.3), singleEvents is
  // hidden in favor of Recurring Event Handling; "expand" is what actually sends singleEvents: true
  // to the Calendar API. Without it, a recurring block (e.g. a weekly hold) would come back as its
  // unexpanded master event, anchored to its first occurrence, so a taken slot could look free.
  const options = recheckSlot?.parameters.options as Record<string, unknown> | undefined;
  expect(options?.recurringEventHandling).toBe('expand');
});

test('Recheck slot availability queries exactly [start, end) of the validated booking', () => {
  expect(recheckSlot?.parameters.timeMin).toBe("={{ $('Validate booking').item.json.start }}");
  expect(recheckSlot?.parameters.timeMax).toBe("={{ $('Validate booking').item.json.end }}");
});
