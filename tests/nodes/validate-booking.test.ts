import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { run, type BookingCheck, type BookingInput } from '../../src/nodes/validate-booking.ts';
import type { Business } from '../../src/nodes/types.ts';

const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
const limits = { max_booking_days_ahead: 60, max_upcoming_bookings: 3 };
const base = { phone: '570000000001', name: 'Laura Gomez', service: 'Dental cleaning', date: '2026-11-04', time: '09:30', upcoming_bookings: 0, limits };
const call = (input: Partial<BookingInput>): BookingCheck =>
  run({ business, now: '2026-11-03T15:00:00-05:00', ...base, ...input });
const reason = (input: Partial<BookingInput>): string | undefined => {
  const r = call(input);
  return r.ok ? undefined : r.reason;
};

test('valid booking returns the event', () => expect(call({})).toEqual({
  ok: true, start: '2026-11-04T09:30:00.000-05:00', end: '2026-11-04T10:15:00.000-05:00',
  service: 'Dental cleaning', price_cop: 120000, summary: 'Appointment: Dental cleaning - Laura Gomez',
  description: 'Phone: 570000000001\nService: Dental cleaning\nBooked by the WhatsApp assistant',
}));
test('service match ignores case and surrounding spaces', () =>
  expect(call({ service: '  dental CLEANING ' })).toMatchObject({ ok: true, service: 'Dental cleaning' }));
test('a service named by its display name in another language books under its canonical name', () => {
  expect(call({ service: 'Limpieza dental' })).toMatchObject({ ok: true, service: 'Dental cleaning', price_cop: 120000, summary: 'Appointment: Dental cleaning - Laura Gomez' });
  expect(call({ service: ' blanqueamiento DENTAL ', time: '10:15' })).toMatchObject({ ok: true, service: 'Teeth whitening', price_cop: 450000 });
});
test('unknown service', () => expect(reason({ service: 'Dental implants' })).toBe('invalid_service'));
test('missing name', () => expect(reason({ name: '' })).toBe('missing_field'));
test('malformed time', () => expect(reason({ time: '9am' })).toBe('invalid_datetime'));
test('sunday is closed', () => expect(reason({ date: '2026-11-08' })).toBe('closed'));
test('ending after closing is outside hours', () => expect(reason({ time: '17:30' })).toBe('outside_hours'));
test('starting before opening is outside hours', () => expect(reason({ time: '07:30' })).toBe('outside_hours'));
test('saturday 11:45 fits, 12:30 does not', () => {
  expect(call({ date: '2026-11-07', time: '11:45' }).ok).toBe(true);
  expect(reason({ date: '2026-11-07', time: '12:30' })).toBe('outside_hours');
});
test('past date', () => expect(reason({ date: '2026-11-02' })).toBe('past'));
test('less than minimum notice', () => expect(reason({ now: '2026-11-04T09:00:00-05:00' })).toBe('too_soon'));

// A start between two offered slots would overlap both of them, so one booking would block two.
test('a time off the slot grid is rejected', () => {
  expect(reason({ time: '08:10' })).toBe('off_grid');
  expect(reason({ time: '09:00' })).toBe('off_grid');
  expect(call({ time: '08:45' }).ok).toBe(true);
});
test('a start past the booking horizon is too far, even years ahead', () => {
  expect(reason({ date: '2031-03-04' })).toBe('too_far');
  // now + 60 days is 2027-01-02 15:00, so that Saturday morning still fits and the Monday after doesn't.
  expect(call({ date: '2027-01-02' }).ok).toBe(true);
  expect(reason({ date: '2027-01-04' })).toBe('too_far');
});
test('a phone at the upcoming-booking limit cannot book another', () => {
  expect(reason({ upcoming_bookings: 3 })).toBe('too_many_bookings');
  expect(reason({ upcoming_bookings: 7 })).toBe('too_many_bookings');
  expect(call({ upcoming_bookings: 2 }).ok).toBe(true);
});
test('missing or invalid booking limits fail with a fixed message instead of allowing every booking', () => {
  const message = 'config.limits.max_booking_days_ahead and config.limits.max_upcoming_bookings must be integers of 1 or more';
  for (const bad of [{}, { max_booking_days_ahead: 60 }, { max_booking_days_ahead: 0, max_upcoming_bookings: 3 }, { max_booking_days_ahead: 60, max_upcoming_bookings: 1.5 }]) {
    expect(() => call({ limits: bad as BookingInput['limits'] })).toThrow(message);
  }
});
