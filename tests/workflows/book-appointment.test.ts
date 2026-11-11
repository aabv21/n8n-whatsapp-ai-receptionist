import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import { CODE_NODES } from '../../scripts/manifest.ts';
import type { Business } from '../../src/nodes/types.ts';
import { runGenerated } from '../helpers/run-generated.ts';
import { nodesOutsideTheirSticky, stickySections } from '../helpers/sticky-sections.ts';

const wf = readWorkflow('workflows/book-appointment.json');
const recheckSlot = wf.nodes.find((n) => n.name === 'Recheck slot availability');

test('no node reads another node through item pairing', () => {
  // One booking request per call, so .first() is always the request, its context, and its
  // validated booking. `.item` would have to pair back through Aggregate upcoming bookings and
  // Check booking limit, which n8n can't always resolve.
  expect(JSON.stringify(wf)).not.toContain("').item");
});

test('Recheck slot availability calls the Google Calendar node', () =>
  expect(recheckSlot?.type).toBe('n8n-nodes-base.googleCalendar'));

test("Recheck slot availability expands recurring events into the queried slot's own occurrence", () => {
  // "expand" sends singleEvents: true, as in check-availability.test.ts; without it, a recurring
  // hold comes back as its master event, so a taken slot could look free.
  const options = recheckSlot?.parameters.options as Record<string, unknown> | undefined;
  expect(options?.recurringEventHandling).toBe('expand');
});

test('Recheck slot availability queries exactly [start, end) of the validated booking', () => {
  expect(recheckSlot?.parameters.timeMin).toBe("={{ $('Validate booking').first().json.start }}");
  expect(recheckSlot?.parameters.timeMax).toBe("={{ $('Validate booking').first().json.end }}");
});

type Edge = { node: string };
const branches = (name: string): Edge[][] => (wf.connections[name] as { main?: Edge[][] } | undefined)?.main ?? [];
const targets = (name: string, index: number): string[] => branches(name)[index]?.map((e) => e.node) ?? [];
const node = (name: string) => wf.nodes.find((n) => n.name === name);
/** Every `[source, branchIndex]` pair in the file whose branch lists `target`. */
function incomingEdges(target: string): [string, number][] {
  const edges: [string, number][] = [];
  for (const source of Object.keys(wf.connections)) {
    branches(source).forEach((branch, index) => {
      if (branch.some((e) => e.node === target)) edges.push([source, index]);
    });
  }
  return edges.sort();
}
const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
const booking = { phone: '570000000001', name: 'Laura Gomez', service: 'Dental cleaning', date: '2026-11-04', time: '09:30', now: '2026-11-03T15:00:00-05:00', business };
const limits = { max_booking_days_ahead: 60, max_upcoming_bookings: 3 };
const jsCode = (name: string): string => String(node(name)?.parameters.jsCode);

test('an invalid request is rejected before any Calendar call, like check-availability', () => {
  expect(targets('Load context', 0)).toEqual(['Prepare booking check']);
  expect(targets('Prepare booking check', 0)).toEqual(['Validate booking']);
  expect(targets('Validate booking', 0)).toEqual(['Decide whether to call Calendar']);
  expect(targets('Decide whether to call Calendar', 0)).toEqual(['Return validation result']);
  expect(targets('Decide whether to call Calendar', 1)).toEqual(['Get upcoming bookings']);
  // The first pass counts no bookings: the real count needs Calendar, which comes after it.
  const prepare = String(node('Prepare booking check')?.parameters.jsonOutput);
  expect(prepare).toContain('upcoming_bookings: 0');
  expect(prepare).toContain('limits: $json.config.limits');
});

test('a missing booking limit stops the run in Validate booking with the fixed message, before Calendar is called', () => {
  expect(() => runGenerated(jsCode('Validate booking'), { ...booking, upcoming_bookings: 0, limits: { max_upcoming_bookings: 3 } }))
    .toThrow('config.limits.max_booking_days_ahead and config.limits.max_upcoming_bookings must be integers of 1 or more');
});

test("a valid request reads the phone's upcoming bookings over the booking horizon, then reruns the same checks with that count", () => {
  const get = node('Get upcoming bookings');
  expect(get?.type).toBe('n8n-nodes-base.googleCalendar');
  expect([get?.parameters.operation, get?.parameters.returnAll]).toEqual(['getAll', true]);
  expect(get?.parameters.timeMin).toBe('={{ $now.toISO() }}');
  expect(get?.parameters.timeMax).toBe("={{ $now.plus({ days: $('Load context').first().json.config.limits.max_booking_days_ahead }).toISO() }}");
  // An empty calendar still continues, and a Calendar failure reports calendar_unavailable like the other Calendar calls.
  expect([get?.alwaysOutputData, get?.onError]).toEqual([true, 'continueErrorOutput']);
  expect(targets('Get upcoming bookings', 0)).toEqual(['Aggregate upcoming bookings']);
  expect(targets('Get upcoming bookings', 1)).toEqual(['Notify calendar failure']);
  expect(targets('Aggregate upcoming bookings', 0)).toEqual(['Prepare limit check']);
  expect(targets('Prepare limit check', 0)).toEqual(['Check booking limit']);
  expect(targets('Check booking limit', 0)).toEqual(['Is the booking limit reached']);
  expect(targets('Is the booking limit reached', 0)).toEqual(['Return validation result']);
  expect(incomingEdges('Recheck slot availability')).toEqual([['Is the booking limit reached', 1]]);
  for (const name of ['Validate booking', 'Check booking limit']) {
    expect(CODE_NODES).toContainEqual(expect.objectContaining({ file: 'book-appointment.json', node: name, source: 'src/nodes/validate-booking.ts' }));
  }
});

test('the limit check counts only events booked for this exact phone, as the description writes it', () => {
  const prepare = String(node('Prepare limit check')?.parameters.jsonOutput);
  expect(prepare).toContain(
    "upcoming_bookings: $json.events.filter((e) => (e.description ?? '').includes('Phone: ' + String($('Receive booking request').first().json.phone).trim() + '\\n')).length",
  );
  expect(prepare).toContain("limits: $('Load context').first().json.config.limits");
  expect(prepare).toContain("business: $('Load context').first().json.business");
  expect(runGenerated(jsCode('Check booking limit'), { ...booking, upcoming_bookings: 3, limits }))
    .toEqual([{ json: { ok: false, reason: 'too_many_bookings' } }]);
  expect(runGenerated(jsCode('Check booking limit'), { ...booking, upcoming_bookings: 2, limits }))
    .toMatchObject([{ json: { ok: true, start: '2026-11-04T09:30:00.000-05:00' } }]);
});

// The Patients row must match the Calendar event, which Validate booking built from the trimmed values.
test('Call upsert-patient maps the trimmed phone and name from Validate booking', () => {
  const value = (node('Call upsert-patient')?.parameters.workflowInputs as { value: Record<string, unknown> }).value;
  expect(value.phone).toBe("={{ $('Validate booking').first().json.phone }}");
  expect(value.name).toBe("={{ $('Validate booking').first().json.name }}");
});

const SECTIONS: Record<string, string[]> = {
  '## Validate offline': ['Validate booking', 'Decide whether to call Calendar', 'Return validation result'],
  '## Booking limit': ['Get upcoming bookings', 'Check booking limit', 'Is the booking limit reached'],
  '## Slot recheck and booking': ['Recheck slot availability', 'Is the slot already taken', 'Create calendar event', 'Call upsert-patient'],
  '## Calendar failure': ['Notify calendar failure', 'Did the alert send'],
};

test('sticky notes label each section, above or around the nodes they name', () => {
  expect(stickySections(wf).map((s) => s.heading).sort()).toEqual(Object.keys(SECTIONS).sort());
  expect(nodesOutsideTheirSticky(wf, SECTIONS)).toEqual([]);
});
