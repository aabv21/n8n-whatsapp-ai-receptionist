import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { run, type BookingCheck, type BookingInput } from '../../src/nodes/validate-booking.ts';
import type { Business } from '../../src/nodes/types.ts';

const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
const base = { phone: '570000000001', name: 'Laura Gomez', service: 'Dental cleaning', date: '2026-11-04', time: '09:30' };
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
