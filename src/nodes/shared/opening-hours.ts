import type { Business, Weekday } from '../types.ts';

const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** `day` at the given "HH:mm" wall-clock time, in `day`'s own zone. */
export function atTime(day: DateTime, time: string): DateTime {
  return day.set({ hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)), second: 0, millisecond: 0 });
}

const TIME_RE = /^\d{2}:\d{2}$/;

/** `date` ("YYYY-MM-DD") at `time` ("HH:mm") in `zone`, or null when either is malformed or not a real calendar date and clock time. */
export function parseSlotStart(date: string, time: string, zone: string): DateTime | null {
  if (!TIME_RE.test(time)) return null;
  // Luxon would roll 24:00 into the next day and 09:60 into 10:00, so both are refused here.
  if (Number(time.slice(0, 2)) > 23 || Number(time.slice(3, 5)) > 59) return null;
  const day = DateTime.fromISO(date, { zone });
  if (!day.isValid) return null;
  const start = atTime(day, time);
  return start.isValid ? start : null;
}

/** The business's opening and closing instants on `day`'s date, or null when it's closed that day. */
export function openingWindow(day: DateTime, business: Business): { open: DateTime; close: DateTime } | null {
  // Luxon's `weekday` runs 1 (Monday) to 7 (Sunday).
  const weekday = WEEKDAYS[day.weekday - 1];
  // eslint-disable-next-line security/detect-object-injection -- weekday is one of the fixed Weekday literals, not user input
  const hours = weekday && business.hours[weekday];
  if (!hours) return null;
  const [openTime, closeTime] = hours;
  return { open: atTime(day, openTime), close: atTime(day, closeTime) };
}
