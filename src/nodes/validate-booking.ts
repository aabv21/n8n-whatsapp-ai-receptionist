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
}

export type BookingCheck =
  | { ok: true; start: string; end: string; service: string; price_cop: number; summary: string; description: string }
  | {
      ok: false;
      reason: 'missing_field' | 'invalid_service' | 'invalid_datetime' | 'closed' | 'outside_hours' | 'past' | 'too_soon';
    };

const TIME_RE = /^\d{2}:\d{2}$/;

/** `dt.toISO()`, which is only null for an invalid DateTime; every instant here is built from a validated date and time. */
function toISOString(dt: DateTime): string {
  const value = dt.toISO();
  if (value === null) throw new Error('unreachable: booking time is always a valid DateTime');
  return value;
}

export function run(input: BookingInput): BookingCheck {
  const { business } = input;
  const zone = business.timezone;

  const phone = input.phone.trim();
  const name = input.name.trim();
  const service = input.service.trim();
  const date = input.date.trim();
  const time = input.time.trim();
  if (!phone || !name || !service || !date || !time) return { ok: false, reason: 'missing_field' };

  const match = business.services.find((s) => s.name.toLowerCase() === service.toLowerCase());
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

  const now = DateTime.fromISO(input.now, { setZone: true }).setZone(zone);
  if (start < now) return { ok: false, reason: 'past' };
  if (start < now.plus({ minutes: business.min_notice_minutes })) return { ok: false, reason: 'too_soon' };

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
