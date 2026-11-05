import { atTime, openingWindow } from './shared/opening-hours.ts';
import type { Business } from './types.ts';

export interface BookingInput {
  phone: string;
  name: string;
  service: string;
  date: string;
  time: string;
  now: string;
  business: Business;
  /** This phone's events in Calendar between now and the booking horizon, counted by the workflow. */
  upcoming_bookings: number;
  limits: { max_booking_days_ahead: number; max_upcoming_bookings: number };
}

export type BookingCheck =
  | { ok: true; start: string; end: string; service: string; price_cop: number; summary: string; description: string }
  | {
      ok: false;
      reason:
        | 'missing_field'
        | 'invalid_service'
        | 'invalid_datetime'
        | 'closed'
        | 'outside_hours'
        | 'off_grid'
        | 'past'
        | 'too_soon'
        | 'too_far'
        | 'too_many_bookings';
    };

const TIME_RE = /^\d{2}:\d{2}$/;

const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

/** `dt.toISO()`, which is only null for an invalid DateTime; every instant here is built from a validated date and time. */
function toISOString(dt: DateTime): string {
  const value = dt.toISO();
  if (value === null) throw new Error('unreachable: booking time is always a valid DateTime');
  return value;
}

export function run(input: BookingInput): BookingCheck {
  const { business, limits } = input;
  // A missing or invalid limit would otherwise let every booking through, so it stops the run instead.
  if (!isPositiveInteger(limits.max_booking_days_ahead) || !isPositiveInteger(limits.max_upcoming_bookings)) {
    throw new Error('config.limits.max_booking_days_ahead and config.limits.max_upcoming_bookings must be integers of 1 or more');
  }
  const zone = business.timezone;

  const phone = input.phone.trim();
  const name = input.name.trim();
  const service = input.service.trim();
  const date = input.date.trim();
  const time = input.time.trim();
  if (!phone || !name || !service || !date || !time) return { ok: false, reason: 'missing_field' };

  // The model is told to send the canonical name, but a translated display name still maps back to it.
  // business.json is mounted live and edited by hand, so a service missing name_i18n still matches by name.
  const wanted = service.toLowerCase();
  const match = business.services.find((s) => [s.name, ...Object.values(s.name_i18n ?? {})].some((n) => n.toLowerCase() === wanted));
  if (!match) return { ok: false, reason: 'invalid_service' };

  if (!TIME_RE.test(time)) return { ok: false, reason: 'invalid_datetime' };
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  if (hour > 23 || minute > 59) return { ok: false, reason: 'invalid_datetime' };
  const day = DateTime.fromISO(date, { zone });
  if (!day.isValid) return { ok: false, reason: 'invalid_datetime' };
  const start = atTime(day, time);
  if (!start.isValid) return { ok: false, reason: 'invalid_datetime' };

  const window = openingWindow(day, business);
  if (!window) return { ok: false, reason: 'closed' };

  const end = start.plus({ minutes: business.appointment_minutes });
  if (start < window.open || end > window.close) return { ok: false, reason: 'outside_hours' };
  // check-availability offers only starts on this grid; a start between two would block both slots.
  if (start.diff(window.open, 'minutes').minutes % business.appointment_minutes !== 0) return { ok: false, reason: 'off_grid' };

  const now = DateTime.fromISO(input.now, { setZone: true }).setZone(zone);
  if (start < now) return { ok: false, reason: 'past' };
  if (start < now.plus({ minutes: business.min_notice_minutes })) return { ok: false, reason: 'too_soon' };
  if (start > now.plus({ days: limits.max_booking_days_ahead })) return { ok: false, reason: 'too_far' };
  if (input.upcoming_bookings >= limits.max_upcoming_bookings) return { ok: false, reason: 'too_many_bookings' };

  return {
    ok: true,
    start: toISOString(start),
    end: toISOString(end),
    service: match.name,
    price_cop: match.price_cop,
    summary: `Appointment: ${match.name} - ${name}`,
    description: `Phone: ${phone}\nService: ${match.name}\nBooked by the WhatsApp assistant`,
  };
}
