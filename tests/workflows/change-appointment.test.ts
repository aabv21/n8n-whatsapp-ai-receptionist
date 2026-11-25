import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { expect, test } from 'vitest';
import { readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';
import { CODE_NODES } from '../../scripts/manifest.ts';
import { run, type CalendarEventItem, type ChangeInput } from '../../src/nodes/plan-appointment-change.ts';
import type { Business } from '../../src/nodes/types.ts';
import { evaluateExpression } from '../helpers/run-expression.ts';
import { runGenerated } from '../helpers/run-generated.ts';
import { nodesNotInsideTheirSticky, stickiesHaveOwnColors, stickySections } from '../helpers/sticky-sections.ts';

const wf = readWorkflow('workflows/change-appointment.json');
const node = (name: string): WorkflowNode => {
  const found = wf.nodes.find((n) => n.name === name);
  if (!found) throw new Error(`no node named ${name}`);
  return found;
};
type Edge = { node: string };
const branches = (name: string): Edge[][] => (wf.connections[name] as { main?: Edge[][] } | undefined)?.main ?? [];
const targets = (name: string, index: number): string[] => branches(name)[index]?.map((e) => e.node) ?? [];
const param = (name: string, key: string): string => String(node(name).parameters[key]);
const inputValues = (name: string): Record<string, string> => (node(name).parameters.workflowInputs as { value: Record<string, string> }).value;
/** The expression an IF node tests. */
const conditionOf = (name: string): string => (node(name).parameters.conditions as { conditions: { leftValue: string }[] }).conditions[0]?.leftValue ?? '';
const evaluate = (expression: string, nodes: Record<string, unknown>, json: unknown = {}, now?: DateTime): unknown =>
  evaluateExpression(expression, { nodes, json, ...(now ? { now } : {}) });

const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
const NOW = '2026-11-03T15:00:00-05:00';
const request = { action: 'reschedule', phone: ' 570000000001 ', date: '2026-11-05', time: '09:30', new_date: '2026-11-06', new_time: '11:00' };
const context = { business, config: { google: { calendar_id: 'cal-1' }, limits: { max_booking_days_ahead: 60 } } };
const owned: CalendarEventItem = {
  id: 'e1',
  summary: 'Appointment: Dental cleaning - Laura Gomez',
  description: 'Phone: 570000000001\nService: Dental cleaning\nBooked by the WhatsApp assistant',
  start: { dateTime: '2026-11-05T09:30:00-05:00' },
  end: { dateTime: '2026-11-05T10:15:00-05:00' },
};
const frozen = (name: string): string => `Object.defineProperty = () => ({});\n${param(name, 'jsCode')}`;

test('the workflow is registered with its own id, and its Code nodes are generated from the plan source', () => {
  expect(wf.id).toBe('cmbChangeAppt001');
  expect(wf.settings.errorWorkflow).toBe('cmbErrorHandler1');
  expect(wf.settings.saveManualExecutions).toBe(false);
  for (const name of ['Check change request', 'Plan appointment change']) {
    expect(CODE_NODES).toContainEqual(expect.objectContaining({ file: 'change-appointment.json', node: name, source: 'src/nodes/plan-appointment-change.ts' }));
  }
});

test('the trigger takes exactly the six string inputs, and no node reads another through item pairing', () => {
  const values = (node('Receive change request').parameters.workflowInputs as { values: { name: string; type: string }[] }).values;
  expect(values).toEqual(['action', 'phone', 'date', 'time', 'new_date', 'new_time'].map((name) => ({ name, type: 'string' })));
  expect(JSON.stringify(wf)).not.toContain("').item");
});

test('no Calendar call before the first pass says checked', () => {
  expect(targets('Load context', 0)).toEqual(['Prepare change check']);
  expect(targets('Prepare change check', 0)).toEqual(['Check change request']);
  expect(targets('Check change request', 0)).toEqual(['Decide whether to call Calendar']);
  expect(targets('Decide whether to call Calendar', 0)).toEqual(['Get upcoming appointments']);
  expect(targets('Decide whether to call Calendar', 1)).toEqual(['Return check result']);
  const expression = conditionOf('Decide whether to call Calendar');
  expect(evaluate(expression, {}, { ok: true, action: 'checked' })).toBe(true);
  expect(evaluate(expression, {}, { ok: true, action: 'list', appointments: [] })).toBe(false);
  expect(evaluate(expression, {}, { ok: false, reason: 'closed' })).toBe(false);
});

test('the first pass sends no events, and the plan sends the Calendar events, over the same request, business and horizon', () => {
  const nodes = { 'Receive change request': request, 'Load context': context };
  const now = DateTime.fromISO(NOW, { setZone: true });
  expect(evaluate(param('Prepare change check', 'jsonOutput'), nodes, context, now)).toEqual({
    ...request,
    now: now.toISO(),
    business,
    max_booking_days_ahead: 60,
    events: null,
  });
  expect(evaluate(param('Prepare change plan', 'jsonOutput'), nodes, { events: [owned] }, now)).toEqual({
    ...request,
    now: now.toISO(),
    business,
    max_booking_days_ahead: 60,
    events: [owned],
  });
});

test('Get upcoming appointments reads Calendar from now to the booking horizon and an empty calendar continues', () => {
  const get = node('Get upcoming appointments');
  const now = DateTime.fromISO(NOW, { setZone: true });
  expect([get.parameters.operation, get.parameters.returnAll]).toEqual(['getAll', true]);
  expect(evaluate(String(get.parameters.timeMin), {}, {}, now)).toBe(now.toISO());
  expect(evaluate(String(get.parameters.timeMax), { 'Load context': context }, {}, now)).toBe(now.plus({ days: 60 }).toISO());
  expect(evaluate((get.parameters.calendar as { value: string }).value, { 'Load context': context })).toBe('cal-1');
  expect(get.alwaysOutputData).toBe(true);
  expect(targets('Get upcoming appointments', 0)).toEqual(['Aggregate appointments']);
  expect(targets('Aggregate appointments', 0)).toEqual(['Prepare change plan']);
  expect(targets('Prepare change plan', 0)).toEqual(['Plan appointment change']);
  expect(targets('Plan appointment change', 0)).toEqual(['Route by plan']);
});

test('the plan reruns the same generated function over the upcoming appointments', () => {
  const input: ChangeInput = { ...request, now: NOW, business, max_booking_days_ahead: 60, events: [owned] };
  expect(runGenerated(param('Plan appointment change', 'jsCode'), input)).toEqual([{ json: run(input) }]);
  expect(runGenerated(param('Check change request', 'jsCode'), { ...input, events: null })).toEqual([{ json: { ok: true, action: 'checked' } }]);
});

test('the generated Plan appointment change node cancels inside a sandbox that freezes Object.defineProperty', () => {
  const input: ChangeInput = { ...request, action: 'cancel', now: NOW, business, max_booking_days_ahead: 60, events: [owned] };
  expect(runGenerated(frozen('Plan appointment change'), input)).toEqual([
    { json: { ok: true, action: 'cancel', event_id: 'e1', service: 'Dental cleaning', start: '2026-11-05T09:30:00.000-05:00', next_start: null } },
  ]);
});

test("a plan for another phone's event is not_found through the generated node, so nothing is routed to a delete", () => {
  const input: ChangeInput = { ...request, phone: '570000000099', action: 'cancel', now: NOW, business, max_booking_days_ahead: 60, events: [owned] };
  expect(runGenerated(param('Plan appointment change', 'jsCode'), input)).toEqual([{ json: { ok: false, reason: 'not_found' } }]);
});

test('Route by plan sends a cancel to the delete, a reschedule to the new-slot recheck, and everything else back as the result', () => {
  const rules = (node('Route by plan').parameters.rules as { values: { outputKey: string; conditions: { conditions: { leftValue: string; rightValue: string }[] } }[] }).values;
  expect(rules.map((r) => [r.outputKey, r.conditions.conditions[0]?.leftValue, r.conditions.conditions[0]?.rightValue])).toEqual([
    ['cancel', '={{ $json.action }}', 'cancel'],
    ['reschedule', '={{ $json.action }}', 'reschedule'],
  ]);
  expect(targets('Route by plan', 0)).toEqual(['Delete calendar event']);
  expect(targets('Route by plan', 1)).toEqual(['Recheck new slot']);
  expect(targets('Route by plan', 2)).toEqual(['Return plan result']);
  expect(evaluate(param('Return plan result', 'jsonOutput'), {}, { ok: true, action: 'list', appointments: [] })).toEqual({ ok: true, action: 'list', appointments: [] });
});

const cancelPlan = { ok: true, action: 'cancel', event_id: 'e1', service: 'Dental cleaning', start: '2026-11-05T09:30:00.000-05:00', next_start: null };
const movePlan = {
  ok: true,
  action: 'reschedule',
  event_id: 'e1',
  service: 'Dental cleaning',
  start: '2026-11-06T11:00:00.000-05:00',
  end: '2026-11-06T11:45:00.000-05:00',
  previous_start: '2026-11-05T09:30:00.000-05:00',
  next_start: '2026-11-04T08:00:00.000-05:00',
  summary: owned.summary,
  description: owned.description,
};

test('cancel deletes exactly the planned event, then marks the patient cancelled', () => {
  const del = node('Delete calendar event');
  expect([del.parameters.resource, del.parameters.operation]).toEqual(['event', 'delete']);
  expect(evaluate(String(del.parameters.eventId), { 'Plan appointment change': cancelPlan })).toBe('e1');
  expect(targets('Delete calendar event', 0)).toEqual(['Mark patient cancelled']);
  expect(targets('Delete calendar event', 1)).toEqual(['Was the event already deleted']);
  const nodes = { 'Receive change request': request, 'Plan appointment change': cancelPlan };
  const values = inputValues('Mark patient cancelled');
  expect(Object.keys(values).sort()).toEqual(['last_appointment', 'phone', 'status']);
  expect(evaluate(String(values.phone), nodes)).toBe('570000000001');
  // The last appointment gone: cancelled, and the row's appointment cleared (blank, which the merge turns into a clear).
  expect(evaluate(String(values.status), nodes)).toBe('cancelled');
  expect(evaluate(String(values.last_appointment), nodes)).toBe('');
  // Another appointment still upcoming: the patient stays booked, pointing at the next one.
  const another = { ...nodes, 'Plan appointment change': { ...cancelPlan, next_start: '2026-11-10T08:00:00.000-05:00' } };
  expect(evaluate(String(values.status), another)).toBe('booked');
  expect(evaluate(String(values.last_appointment), another)).toBe('2026-11-10T08:00:00.000-05:00');
  expect((node('Mark patient cancelled').parameters.workflowId as { value: string }).value).toBe('cmbUpsertPatient');
  expect(targets('Mark patient cancelled', 0)).toEqual(['Return cancel success']);
  expect(evaluate(param('Return cancel success', 'jsonOutput'), nodes)).toEqual({
    ok: true,
    action: 'cancel',
    service: 'Dental cleaning',
    start: '2026-11-05T09:30:00.000-05:00',
  });
});

test('a delete that errors after an earlier try already removed the event counts as cancelled', () => {
  const expression = conditionOf('Was the event already deleted');
  // What Google answers to the retry of a delete that had worked: 410 Gone, or 404 Not Found.
  for (const error of ['Resource has been deleted', 'The resource you are requesting could not be found', '410', { httpCode: '404', message: 'Not Found' }, { description: 'Resource has been deleted', httpCode: '410' }]) {
    expect(evaluate(expression, {}, { error }), JSON.stringify(error)).toBe(true);
  }
  for (const error of ['The service is currently unavailable', { httpCode: '503', message: 'Service Unavailable' }, { httpCode: '403', message: 'Forbidden' }, '', undefined]) {
    expect(evaluate(expression, {}, { error }), JSON.stringify(error)).toBe(false);
  }
  expect(targets('Was the event already deleted', 0)).toEqual(['Mark patient cancelled']);
  expect(targets('Was the event already deleted', 1)).toEqual(['Notify calendar failure']);
});

test('the new-slot recheck queries exactly the new slot and ignores the appointment being moved', () => {
  const recheck = node('Recheck new slot');
  const nodes = { 'Plan appointment change': movePlan };
  expect(evaluate(String(recheck.parameters.timeMin), nodes)).toBe(movePlan.start);
  expect(evaluate(String(recheck.parameters.timeMax), nodes)).toBe(movePlan.end);
  expect((recheck.parameters.options as Record<string, unknown>).recurringEventHandling).toBe('expand');
  expect(recheck.alwaysOutputData).toBe(true);
  const expression = conditionOf('Is the new slot taken');
  expect(evaluate(expression, nodes, { events: [{ id: 'e1' }] })).toBe(false);
  expect(evaluate(expression, nodes, { events: [{ id: 'e2' }] })).toBe(true);
  expect(evaluate(expression, nodes, { events: [{ id: 'e1' }, { id: 'e2' }] })).toBe(true);
  // Always Output Data hands one empty item to an empty slot.
  expect(evaluate(expression, nodes, { events: [{}] })).toBe(false);
  expect(targets('Is the new slot taken', 0)).toEqual(['Return slot taken']);
  expect(targets('Is the new slot taken', 1)).toEqual(['Move calendar event']);
  expect(JSON.parse(param('Return slot taken', 'jsonOutput'))).toEqual({ ok: false, reason: 'slot_taken' });
});

test("a move updates only the planned event's times, sends its own title and description back, then marks the patient booked", () => {
  const move = node('Move calendar event');
  const nodes = { 'Receive change request': request, 'Plan appointment change': movePlan };
  expect([move.parameters.resource, move.parameters.operation]).toEqual(['event', 'update']);
  expect(evaluate(String(move.parameters.eventId), nodes)).toBe('e1');
  const fields = move.parameters.updateFields as Record<string, string>;
  expect(Object.keys(fields).sort()).toEqual(['description', 'end', 'start', 'summary']);
  expect(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, evaluate(value, nodes)]))).toEqual({
    start: movePlan.start,
    end: movePlan.end,
    summary: owned.summary,
    description: owned.description,
  });
  expect(targets('Move calendar event', 0)).toEqual(['Mark patient rebooked']);
  expect(targets('Move calendar event', 1)).toEqual(['Notify calendar failure']);
  const values = inputValues('Mark patient rebooked');
  expect(Object.keys(values).sort()).toEqual(['last_appointment', 'phone', 'status']);
  expect(evaluate(String(values.phone), nodes)).toBe('570000000001');
  expect(values.status).toBe('booked');
  // The earliest appointment the patient holds after the move, which may be another one.
  expect(evaluate(String(values.last_appointment), nodes)).toBe(movePlan.next_start);
  expect(evaluate(param('Return reschedule success', 'jsonOutput'), nodes)).toEqual({
    ok: true,
    action: 'reschedule',
    service: 'Dental cleaning',
    start: movePlan.start,
    end: movePlan.end,
    previous_start: movePlan.previous_start,
  });
});

test('every Calendar node retries 3 times 1000 ms apart and sends failures to notify-team as tool_failure', () => {
  const calendars = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleCalendar');
  expect(calendars.map((n) => n.name).sort()).toEqual(['Delete calendar event', 'Get upcoming appointments', 'Move calendar event', 'Recheck new slot']);
  for (const n of calendars) {
    expect([n.retryOnFail, n.maxTries, n.waitBetweenTries, n.onError]).toEqual([true, 3, 1000, 'continueErrorOutput']);
    // A failed delete first asks whether the event is already gone; every other Calendar failure alerts at once.
    expect(targets(n.name, 1)).toEqual([n.name === 'Delete calendar event' ? 'Was the event already deleted' : 'Notify calendar failure']);
    expect(n.credentials).toEqual({ googleCalendarOAuth2Api: { id: 'cmbCredGCalendar', name: 'Google Calendar' } });
  }
  const values = inputValues('Notify calendar failure');
  expect(values.reason).toBe('tool_failure');
  expect(values.summary).toBe('=change_appointment: {{ $json.error }}');
  expect(evaluate(String(values.phone), { 'Receive change request': request })).toBe(request.phone);
  expect(targets('Notify calendar failure', 0)).toEqual(['Did the alert send']);
  expect(targets('Did the alert send', 0)).toEqual(['Return failure with alert']);
  expect(targets('Did the alert send', 1)).toEqual(['Return failure without alert']);
  expect(JSON.parse(param('Return failure with alert', 'jsonOutput'))).toEqual({ ok: false, reason: 'calendar_unavailable', team_notified: true });
  expect(JSON.parse(param('Return failure without alert', 'jsonOutput'))).toEqual({ ok: false, reason: 'calendar_unavailable' });
});

const SECTIONS: Record<string, string[]> = {
  '## Change appointment': ['Receive change request', 'Load context', 'Prepare change check', 'Check change request', 'Decide whether to call Calendar', 'Return check result'],
  '## Find the appointment': ['Get upcoming appointments', 'Aggregate appointments', 'Prepare change plan', 'Plan appointment change', 'Route by plan', 'Return plan result'],
  '## Cancel': ['Delete calendar event', 'Was the event already deleted', 'Mark patient cancelled', 'Return cancel success'],
  '## Reschedule': [
    'Recheck new slot', 'Aggregate busy events', 'Is the new slot taken', 'Return slot taken', 'Move calendar event', 'Mark patient rebooked',
    'Return reschedule success',
  ],
  '## Calendar failure': ['Notify calendar failure', 'Did the alert send', 'Return failure with alert', 'Return failure without alert'],
};

test('sticky notes enclose each section, each in its own color', () => {
  expect(stickySections(wf).map((s) => s.heading).sort()).toEqual(Object.keys(SECTIONS).sort());
  expect(nodesNotInsideTheirSticky(wf, SECTIONS)).toEqual([]);
  expect(stickiesHaveOwnColors(wf)).toBe(true);
  const covered = Object.values(SECTIONS).flat();
  expect(wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !covered.includes(n.name)).map((n) => n.name)).toEqual([]);
});
