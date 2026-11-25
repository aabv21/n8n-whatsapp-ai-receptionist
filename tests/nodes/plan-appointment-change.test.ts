import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { CHANGE_REASONS, run, type CalendarEventItem, type ChangeInput, type ChangePlan } from '../../src/nodes/plan-appointment-change.ts';
import type { Business } from '../../src/nodes/types.ts';

const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
const owned: CalendarEventItem = {
  id: 'e1',
  summary: 'Appointment: Dental cleaning - Laura Gomez',
  description: 'Phone: 570000000001\nService: Dental cleaning\nBooked by the WhatsApp assistant',
  start: { dateTime: '2026-11-05T09:30:00-05:00' },
  end: { dateTime: '2026-11-05T10:15:00-05:00' },
};
const base: ChangeInput = {
  action: 'cancel',
  phone: '570000000001',
  date: '2026-11-05',
  time: '09:30',
  new_date: '',
  new_time: '',
  now: '2026-11-03T15:00:00-05:00',
  business,
  max_booking_days_ahead: 60,
  events: [owned],
};
const call = (input: Partial<ChangeInput>): ChangePlan => run({ ...base, ...input });
const reason = (input: Partial<ChangeInput>): string | undefined => {
  const plan = call(input);
  return plan.ok ? undefined : plan.reason;
};

test("list gives this phone's upcoming appointments in local time, oldest first", () => {
  const later: CalendarEventItem = { ...owned, id: 'e0', start: { dateTime: '2026-11-04T08:00:00-05:00' }, end: { dateTime: '2026-11-04T08:45:00-05:00' } };
  const other: CalendarEventItem = { ...owned, id: 'e2', description: 'Phone: 570000000002\nService: Dental cleaning\nBooked by the WhatsApp assistant' };
  const past: CalendarEventItem = { ...owned, id: 'e3', start: { dateTime: '2026-11-02T09:30:00-05:00' }, end: { dateTime: '2026-11-02T10:15:00-05:00' } };
  expect(call({ action: 'list', events: [owned, other, past, later] })).toEqual({
    ok: true,
    action: 'list',
    appointments: [
      { date: '2026-11-04', time: '08:00', service: 'Dental cleaning' },
      { date: '2026-11-05', time: '09:30', service: 'Dental cleaning' },
    ],
  });
});

test('cancel finds the appointment by local day and time and returns its id', () =>
  expect(call({})).toEqual({ ok: true, action: 'cancel', event_id: 'e1', service: 'Dental cleaning', start: '2026-11-05T09:30:00.000-05:00', next_start: null }));

test("a cancel reports the patient's next upcoming appointment, so the Patients row stays honest", () => {
  const later: CalendarEventItem = { ...owned, id: 'e9', start: { dateTime: '2026-11-10T08:00:00-05:00' }, end: { dateTime: '2026-11-10T08:45:00-05:00' } };
  const sooner: CalendarEventItem = { ...owned, id: 'e8', start: { dateTime: '2026-11-04T08:00:00-05:00' }, end: { dateTime: '2026-11-04T08:45:00-05:00' } };
  const other: CalendarEventItem = { ...owned, id: 'e7', description: 'Phone: 570000000002\nService: Dental cleaning\nBooked by the WhatsApp assistant', start: { dateTime: '2026-11-04T09:00:00-05:00' } };
  expect(call({ events: [owned, later] })).toMatchObject({ action: 'cancel', event_id: 'e1', next_start: '2026-11-10T08:00:00.000-05:00' });
  expect(call({ events: [later, owned, sooner, other] })).toMatchObject({ event_id: 'e1', next_start: '2026-11-04T08:00:00.000-05:00' });
  // Another phone's event, or the cancelled one itself, never counts as the next appointment.
  expect(call({ events: [owned, other] })).toMatchObject({ next_start: null });
});

test("a move reports the earliest of the patient's appointments after it, never a later one than another they hold", () => {
  const move = { action: 'reschedule', new_date: '2026-11-06', new_time: '11:00' };
  const earlier: CalendarEventItem = { ...owned, id: 'e6', start: { dateTime: '2026-11-04T08:00:00-05:00' }, end: { dateTime: '2026-11-04T08:45:00-05:00' } };
  expect(call(move)).toMatchObject({ next_start: '2026-11-06T11:00:00.000-05:00' });
  expect(call({ ...move, events: [owned, earlier] })).toMatchObject({ next_start: '2026-11-04T08:00:00.000-05:00' });
});

test("an event Calendar returns in UTC still matches the patient's local day and time", () => {
  const utc = { ...owned, start: { dateTime: '2026-11-05T14:30:00Z' }, end: { dateTime: '2026-11-05T15:15:00Z' } };
  expect(call({ events: [utc] })).toMatchObject({ ok: true, action: 'cancel', event_id: 'e1', start: '2026-11-05T09:30:00.000-05:00' });
});

test('an event whose description carries another phone is not_found, even at the same start', () => {
  const someoneElse = { ...owned, description: 'Phone: 570000000002\nService: Dental cleaning\nBooked by the WhatsApp assistant' };
  expect(reason({ events: [someoneElse] })).toBe('not_found');
  expect(reason({ action: 'reschedule', new_date: '2026-11-06', new_time: '11:00', events: [someoneElse] })).toBe('not_found');
});

test('a phone that only shares a prefix or a line with the sender is not the owner', () => {
  const longer = { ...owned, description: 'Phone: 5700000000012\nService: Dental cleaning\nBooked by the WhatsApp assistant' };
  const quoted = { ...owned, description: 'Note: Phone: 570000000001\nService: Dental cleaning\nBooked by the WhatsApp assistant' };
  expect(reason({ events: [longer] })).toBe('not_found');
  expect(reason({ events: [quoted] })).toBe('not_found');
});

test('an event staff made by hand, with no phone line, is not_found and never listed', () => {
  const byHand: CalendarEventItem = { id: 'h1', description: 'Laura Gomez, cleaning', start: { dateTime: '2026-11-05T09:30:00-05:00' }, end: { dateTime: '2026-11-05T10:15:00-05:00' } };
  const noDescription: CalendarEventItem = { id: 'h2', start: { dateTime: '2026-11-05T09:30:00-05:00' }, end: { dateTime: '2026-11-05T10:15:00-05:00' } };
  const unmarked: CalendarEventItem = { ...owned, id: 'h3', description: 'Phone: 570000000001\nService: Dental cleaning' };
  expect(reason({ events: [byHand, noDescription, unmarked] })).toBe('not_found');
  expect(call({ action: 'list', events: [byHand, noDescription, unmarked] })).toEqual({ ok: true, action: 'list', appointments: [] });
});

test('an all-day event with no start time is never matched or listed', () => {
  const allDay = { ...owned, id: 'a1', start: { date: '2026-11-05' }, end: { date: '2026-11-06' } } as CalendarEventItem;
  expect(call({ action: 'list', events: [allDay] })).toEqual({ ok: true, action: 'list', appointments: [] });
  expect(reason({ events: [allDay] })).toBe('not_found');
});

test('an appointment exactly change_notice_hours away can change; one minute closer is too_late_to_change', () => {
  const dayAfter = { ...owned, start: { dateTime: '2026-11-04T15:00:00-05:00' }, end: { dateTime: '2026-11-04T15:45:00-05:00' } };
  const input = { date: '2026-11-04', time: '15:00', events: [dayAfter] };
  expect(call({ ...input, now: '2026-11-03T15:00:00-05:00' })).toMatchObject({ ok: true, action: 'cancel' });
  expect(reason({ ...input, now: '2026-11-03T15:01:00-05:00' })).toBe('too_late_to_change');
  expect(call({ ...input, action: 'reschedule', new_date: '2026-11-06', new_time: '11:00', now: '2026-11-03T15:00:00-05:00' })).toMatchObject({ ok: true, action: 'reschedule' });
  expect(reason({ ...input, action: 'reschedule', new_date: '2026-11-06', new_time: '11:00', now: '2026-11-03T15:01:00-05:00' })).toBe('too_late_to_change');
});

test('reschedule validates the new slot with the booking rules before any lookup', () => {
  const move = { action: 'reschedule', new_time: '11:00', events: null };
  expect(reason({ ...move, new_date: '2026-11-08' })).toBe('closed');
  expect(reason({ ...move, new_date: '2026-11-06', new_time: '11:10' })).toBe('off_grid');
  expect(reason({ ...move, new_date: '2026-11-03', new_time: '08:00' })).toBe('past');
  expect(reason({ ...move, new_date: '2026-11-03', new_time: '15:30' })).toBe('too_soon');
  expect(reason({ ...move, new_date: '2027-03-01' })).toBe('too_far');
  expect(reason({ ...move, new_date: '2026-11-06', new_time: '25:00' })).toBe('invalid_datetime');
});

test('the horizon follows max_booking_days_ahead, as a new booking does', () => {
  const move = { action: 'reschedule', new_time: '11:00', events: null };
  expect(reason({ ...move, new_date: '2026-11-13', max_booking_days_ahead: 10 })).toBeUndefined();
  expect(reason({ ...move, new_date: '2026-11-14', max_booking_days_ahead: 10 })).toBe('too_far');
});

test('reschedule returns the new start and end and the previous start', () =>
  expect(call({ action: 'reschedule', new_date: '2026-11-06', new_time: '11:00' })).toEqual({
    ok: true,
    action: 'reschedule',
    event_id: 'e1',
    service: 'Dental cleaning',
    start: '2026-11-06T11:00:00.000-05:00',
    end: '2026-11-06T11:45:00.000-05:00',
    previous_start: '2026-11-05T09:30:00.000-05:00',
    next_start: '2026-11-06T11:00:00.000-05:00',
    // Sent back with the move, so an update that replaces the event can't drop the ownership line.
    summary: 'Appointment: Dental cleaning - Laura Gomez',
    description: 'Phone: 570000000001\nService: Dental cleaning\nBooked by the WhatsApp assistant',
  }));

test('the first pass, with no events, stops at checked', () => {
  expect(call({ events: null })).toEqual({ ok: true, action: 'checked' });
  expect(call({ action: 'list', events: null })).toEqual({ ok: true, action: 'checked' });
  expect(call({ action: 'reschedule', new_date: '2026-11-06', new_time: '11:00', events: null })).toEqual({ ok: true, action: 'checked' });
});

test('an unknown action is invalid_action; blank fields are missing_field; a malformed time is invalid_datetime', () => {
  expect(reason({ action: 'delete' })).toBe('invalid_action');
  expect(reason({ action: '' })).toBe('invalid_action');
  expect(reason({ date: ' ' })).toBe('missing_field');
  expect(reason({ time: '' })).toBe('missing_field');
  expect(reason({ phone: ' ' })).toBe('missing_field');
  expect(reason({ action: 'reschedule', new_date: '', new_time: '11:00' })).toBe('missing_field');
  expect(reason({ action: 'reschedule', new_date: '2026-11-06', new_time: ' ' })).toBe('missing_field');
  expect(reason({ time: '9:30' })).toBe('invalid_datetime');
  expect(reason({ time: '09:60' })).toBe('invalid_datetime');
  expect(reason({ date: '2026-13-40' })).toBe('invalid_datetime');
});

test('a field the caller leaves out is missing_field, not a crash', () => {
  expect(reason({ date: undefined as unknown as string })).toBe('missing_field');
  expect(reason({ action: undefined as unknown as string })).toBe('invalid_action');
});

test('list needs no date, time or new slot', () =>
  expect(call({ action: 'list', date: '', time: '', events: [] })).toEqual({ ok: true, action: 'list', appointments: [] }));

test('the phone is trimmed before it is matched', () =>
  expect(call({ phone: ' 570000000001 ' })).toMatchObject({ ok: true, action: 'cancel', event_id: 'e1' }));

test('CHANGE_REASONS lists exactly the reasons run() returns', () => {
  const seen = new Set<string>();
  const moves = { action: 'reschedule', new_date: '2026-11-06', new_time: '11:00' };
  const tries: Partial<ChangeInput>[] = [
    { action: 'x' },
    { date: '' },
    { time: '9:30' },
    { ...moves, new_date: '2026-11-08' },
    { ...moves, new_time: '07:00' },
    { ...moves, new_time: '11:10' },
    { ...moves, new_date: '2026-11-03', new_time: '08:00' },
    { ...moves, new_date: '2026-11-03', new_time: '15:30' },
    { ...moves, new_date: '2027-03-01' },
    { events: [] },
    { now: '2026-11-04T10:00:00-05:00' },
    { ...moves, new_date: '2026-11-08', time: '07:00', date: '2026-11-08' },
  ];
  for (const t of tries) {
    const plan = call(t);
    if (!plan.ok) seen.add(plan.reason);
  }
  // `closed` and `outside_hours` come from the new slot; every other reason is reachable above.
  expect([...seen].sort()).toEqual([...CHANGE_REASONS].sort());
});

test('a missing or invalid max_booking_days_ahead fails with a fixed message', () => {
  for (const bad of [undefined, 0, 1.5, '60', null]) {
    expect(() => call({ max_booking_days_ahead: bad as unknown as number })).toThrow('config.limits.max_booking_days_ahead must be an integer of 1 or more');
  }
});

test('a missing or invalid change_notice_hours fails with a fixed message instead of letting every change through', () => {
  for (const bad of [undefined, 0, -1, 2.5, '24']) {
    expect(() => call({ business: { ...business, change_notice_hours: bad as unknown as number } })).toThrow('change_notice_hours must be an integer of 1 or more');
  }
});
