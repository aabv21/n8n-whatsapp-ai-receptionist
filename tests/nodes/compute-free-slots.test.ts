import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { run, type CalendarEvent, type FreeSlotsInput, type FreeSlotsOutput } from '../../src/nodes/compute-free-slots.ts';
import type { Business } from '../../src/nodes/types.ts';

const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
const dayBefore = '2026-11-03T15:00:00-05:00';
const call = (input: Partial<FreeSlotsInput>): FreeSlotsOutput =>
  run({ business, events: [], date: '2026-11-04', now: dayBefore, ...input });
const labels = (r: FreeSlotsOutput): string[] => (r.ok ? r.slots.map((s) => s.label) : []);
const busy = (from: string, to: string): CalendarEvent => ({ start: { dateTime: from }, end: { dateTime: to } });

test('weekday with an empty calendar offers the first three slots', () =>
  expect(labels(call({}))).toEqual(['08:00', '08:45', '09:30']));
test('slots carry ISO start and end in Bogota time', () =>
  expect(call({})).toMatchObject({ ok: true, date: '2026-11-04',
    slots: [{ start: '2026-11-04T08:00:00.000-05:00', end: '2026-11-04T08:45:00.000-05:00', label: '08:00' }, {}, {}] }));
test('sunday is closed', () => expect(call({ date: '2026-11-08' })).toEqual({ ok: false, reason: 'closed' }));
test('past date is rejected', () => expect(call({ date: '2026-11-02' })).toEqual({ ok: false, reason: 'past_date' }));
test('invalid date is rejected', () => expect(call({ date: '2026-13-40' })).toEqual({ ok: false, reason: 'invalid_date' }));
test('same day respects minimum notice', () =>
  expect(labels(call({ now: '2026-11-04T10:10:00-05:00' }))).toEqual(['11:45', '12:30', '13:15']));
test('busy event blocks overlapping slots', () =>
  expect(labels(call({ events: [busy('2026-11-04T08:30:00-05:00', '2026-11-04T09:15:00-05:00')] })))
    .toEqual(['09:30', '10:15', '11:00']));
test('saturday slots end by closing time', () =>
  expect(labels(call({ date: '2026-11-07', events: [busy('2026-11-07T08:00:00-05:00', '2026-11-07T11:45:00-05:00')] })))
    .toEqual(['11:45']));
test('all-day event blocks the whole day', () =>
  expect(call({ events: [{ start: { date: '2026-11-04' }, end: { date: '2026-11-05' } }] }))
    .toEqual({ ok: false, reason: 'no_slots' }));
test('late in the day leaves no slots', () =>
  expect(call({ now: '2026-11-04T17:30:00-05:00' })).toEqual({ ok: false, reason: 'no_slots' }));
test('an empty item from an empty calendar is ignored', () =>
  expect(labels(call({ events: [{}] }))).toEqual(['08:00', '08:45', '09:30']));
