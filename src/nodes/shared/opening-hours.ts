import type { Business, Weekday } from '../types.ts';

const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** `day` at the given "HH:mm" wall-clock time, in `day`'s own zone. */
export function atTime(day: DateTime, time: string): DateTime {
  return day.set({ hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)), second: 0, millisecond: 0 });
}

/** The business's opening and closing instants on `day`'s date, or null when it's closed that day. */
export function openingWindow(day: DateTime, business: Business): { open: DateTime; close: DateTime } | null {
  // Luxon's `weekday` is 1 (Monday) .. 7 (Sunday); `day.weekday - 1` indexes WEEKDAYS the same way.
  const weekday = WEEKDAYS[day.weekday - 1];
  // eslint-disable-next-line security/detect-object-injection -- weekday is one of the fixed Weekday literals, not user input
  const hours = weekday && business.hours[weekday];
  if (!hours) return null;
  const [openTime, closeTime] = hours;
  return { open: atTime(day, openTime), close: atTime(day, closeTime) };
}
