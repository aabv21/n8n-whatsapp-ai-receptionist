import { isPositiveInteger } from './shared/limits.ts';
import { openingWindow } from './shared/opening-hours.ts';
import type { Business } from './types.ts';

export interface CalendarEvent {
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export interface FreeSlotsInput {
  date: string;
  now: string;
  events: CalendarEvent[];
  business: Business;
  /** `config.limits.max_booking_days_ahead`, the horizon `validate-booking` also enforces. */
  max_booking_days_ahead: number;
}

export interface Slot {
  start: string;
  end: string;
  label: string;
}

/** Every reason a day can have no slots, in the order they're checked. */
export const FREE_SLOT_REASONS = ['invalid_date', 'past_date', 'too_far', 'closed', 'no_slots'] as const;

export type FreeSlotsOutput =
  | { ok: true; date: string; slots: Slot[] }
  | { ok: false; reason: (typeof FREE_SLOT_REASONS)[number] };

interface Window {
  start: DateTime;
  end: DateTime;
}

/** An event's [start, end) instants in `zone`, or null for an event with neither a timed nor an all-day boundary. */
function eventWindow(event: CalendarEvent, zone: string): Window | null {
  const { start, end } = event;
  if (start?.dateTime && end?.dateTime) {
    return {
      start: DateTime.fromISO(start.dateTime, { setZone: true }).setZone(zone),
      end: DateTime.fromISO(end.dateTime, { setZone: true }).setZone(zone),
    };
  }
  // All-day events use calendar dates, with `end.date` exclusive (Google Calendar's own convention).
  if (start?.date && end?.date) {
    return {
      start: DateTime.fromISO(start.date, { zone }).startOf('day'),
      end: DateTime.fromISO(end.date, { zone }).startOf('day'),
    };
  }
  return null;
}

function overlaps(slot: Window, event: Window): boolean {
  return slot.start < event.end && event.start < slot.end;
}

/** `dt.toISO()`, which is only null for an invalid DateTime; every slot time here is built from a validated day. */
function toISOString(dt: DateTime): string {
  const value = dt.toISO();
  if (value === null) throw new Error('unreachable: slot time is always a valid DateTime');
  return value;
}

export function run(input: FreeSlotsInput): FreeSlotsOutput {
  const { business } = input;
  // Without a horizon this would offer slots book-appointment refuses, so it stops the run instead.
  if (!isPositiveInteger(input.max_booking_days_ahead)) {
    throw new Error('config.limits.max_booking_days_ahead must be an integer of 1 or more');
  }
  const zone = business.timezone;

  const day = DateTime.fromISO(input.date, { zone });
  if (!day.isValid) return { ok: false, reason: 'invalid_date' };

  const now = DateTime.fromISO(input.now, { setZone: true }).setZone(zone);
  if (day < now.startOf('day')) return { ok: false, reason: 'past_date' };

  // The same bound validate-booking uses: a slot may start at the horizon, never after it.
  const horizon = now.plus({ days: input.max_booking_days_ahead });
  if (day.startOf('day') > horizon) return { ok: false, reason: 'too_far' };

  const window = openingWindow(day, business);
  if (!window) return { ok: false, reason: 'closed' };

  const grid: DateTime[] = [];
  for (
    let start = window.open;
    start.plus({ minutes: business.appointment_minutes }) <= window.close;
    start = start.plus({ minutes: business.appointment_minutes })
  ) {
    grid.push(start);
  }

  const busyWindows = input.events.map((event) => eventWindow(event, zone)).filter((w): w is Window => w !== null);
  const earliest = now.plus({ minutes: business.min_notice_minutes });

  const slots: Slot[] = grid
    .filter((start) => start >= earliest && start <= horizon)
    .map((start) => ({ start, end: start.plus({ minutes: business.appointment_minutes }) }))
    .filter((slot) => !busyWindows.some((event) => overlaps(slot, event)))
    .slice(0, business.max_slots_offered)
    .map((slot) => ({ start: toISOString(slot.start), end: toISOString(slot.end), label: slot.start.toFormat('HH:mm') }));

  if (slots.length === 0) return { ok: false, reason: 'no_slots' };
  return { ok: true, date: input.date, slots };
}
