import { checkSlot } from './validate-booking.ts';
import { isPositiveInteger } from './shared/limits.ts';
import { parseSlotStart } from './shared/opening-hours.ts';
import type { Business } from './types.ts';

export const CHANGE_ACTIONS = ['list', 'cancel', 'reschedule'] as const;

/** Every reason a change can be refused, in the order `run` finds them. */
export const CHANGE_REASONS = [
  'invalid_action',
  'missing_field',
  'invalid_datetime',
  'closed',
  'outside_hours',
  'off_grid',
  'past',
  'too_soon',
  'too_far',
  'not_found',
  'too_late_to_change',
] as const;

/** The parts of a Google Calendar event this plan reads. */
export interface CalendarEventItem {
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
}

export interface ChangeInput {
  action: string;
  /** From the incoming WhatsApp message, never from the model. */
  phone: string;
  date: string;
  time: string;
  new_date: string;
  new_time: string;
  now: string;
  business: Business;
  max_booking_days_ahead: number;
  /** Calendar's events from now to the booking horizon, or null on the first pass, before Calendar is read. */
  events: CalendarEventItem[] | null;
}

export type ChangePlan =
  | { ok: true; action: 'checked' }
  | { ok: true; action: 'list'; appointments: { date: string; time: string; service: string }[] }
  | {
      ok: true;
      action: 'cancel';
      event_id: string;
      service: string;
      start: string;
      /** The patient's earliest other upcoming appointment, or null when this was their last one. */
      next_start: string | null;
    }
  | {
      ok: true;
      action: 'reschedule';
      event_id: string;
      service: string;
      start: string;
      end: string;
      previous_start: string;
      /** The patient's earliest upcoming appointment once the move is made: the new slot, or another they already hold. */
      next_start: string;
      /** The event's own title and description, sent back with the move so an update that replaces the event can't drop them. */
      summary: string;
      description: string;
    }
  | { ok: false; reason: (typeof CHANGE_REASONS)[number] };

/** The line `validate-booking` writes into every event the assistant creates. */
const BOOKED_BY_LINE = 'Booked by the WhatsApp assistant';

/** `dt.toISO()`, which is only null for an invalid DateTime; every instant here comes from a parsed event or a validated slot. */
function toISOString(dt: DateTime): string {
  const value = dt.toISO();
  if (value === null) throw new Error('unreachable: appointment time is always a valid DateTime');
  return value;
}

/** A trimmed string, or '' for anything else: a caller that leaves a field out gets `missing_field`, not a crash. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface Owned {
  id: string;
  start: DateTime;
  service: string;
  summary: string;
  description: string;
}

/**
 * The patient's own upcoming appointments, oldest first. An event counts only when one line of its
 * description is exactly this phone and another is the assistant's own booking line, so an event
 * staff made by hand, or one for another phone, is never matched, listed, moved or deleted.
 */
function ownedEvents(events: CalendarEventItem[], phone: string, now: DateTime, zone: string): Owned[] {
  const owned: Owned[] = [];
  for (const event of events) {
    const lines = (event.description ?? '').split('\n').map((line) => line.replace(/\r$/, ''));
    const dateTime = event.start?.dateTime;
    if (!event.id || !dateTime || !lines.includes(`Phone: ${phone}`) || !lines.includes(BOOKED_BY_LINE)) continue;
    const start = DateTime.fromISO(dateTime, { setZone: true }).setZone(zone);
    if (!start.isValid || start < now) continue;
    const description = event.description ?? '';
    const service = /^Service: (.+)$/m.exec(description)?.[1] ?? '';
    owned.push({ id: event.id, start, service, summary: event.summary ?? '', description });
  }
  return owned.sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

export function run(input: ChangeInput): ChangePlan {
  const { business } = input;
  // A missing or invalid limit would otherwise let every change through, so it stops the run instead.
  if (!isPositiveInteger(input.max_booking_days_ahead)) {
    throw new Error('config.limits.max_booking_days_ahead must be an integer of 1 or more');
  }
  if (!isPositiveInteger(business.change_notice_hours)) {
    throw new Error('business.change_notice_hours must be an integer of 1 or more');
  }
  const zone = business.timezone;

  const action = text(input.action);
  if (!(CHANGE_ACTIONS as readonly string[]).includes(action)) return { ok: false, reason: 'invalid_action' };
  const phone = text(input.phone);
  const date = text(input.date);
  const time = text(input.time);
  const newDate = text(input.new_date);
  const newTime = text(input.new_time);
  if (!phone) return { ok: false, reason: 'missing_field' };

  let target: DateTime | null = null;
  if (action !== 'list') {
    if (!date || !time) return { ok: false, reason: 'missing_field' };
    target = parseSlotStart(date, time, zone);
    if (!target) return { ok: false, reason: 'invalid_datetime' };
  }

  let moveTo: { start: DateTime; end: DateTime } | null = null;
  if (action === 'reschedule') {
    if (!newDate || !newTime) return { ok: false, reason: 'missing_field' };
    // The same checks a new booking passes: opening hours, slot grid, minimum notice and horizon.
    const slot = checkSlot({ date: newDate, time: newTime, now: input.now, business, max_booking_days_ahead: input.max_booking_days_ahead });
    if (!slot.ok) return { ok: false, reason: slot.reason };
    moveTo = slot;
  }

  if (input.events === null) return { ok: true, action: 'checked' };

  const now = DateTime.fromISO(input.now, { setZone: true }).setZone(zone);
  const owned = ownedEvents(input.events, phone, now, zone);
  if (action === 'list') {
    return {
      ok: true,
      action: 'list',
      appointments: owned.map((o) => ({ date: o.start.toFormat('yyyy-LL-dd'), time: o.start.toFormat('HH:mm'), service: o.service })),
    };
  }

  const found = owned.find((o) => target !== null && o.start.toMillis() === target.toMillis());
  if (!found) return { ok: false, reason: 'not_found' };
  // Exactly change_notice_hours away still counts as enough notice.
  if (found.start < now.plus({ hours: business.change_notice_hours })) return { ok: false, reason: 'too_late_to_change' };

  const others = owned.filter((o) => o.id !== found.id);
  if (moveTo) {
    const earliest = [moveTo.start, ...others.map((o) => o.start)].reduce((a, b) => (b < a ? b : a));
    return {
      ok: true,
      action: 'reschedule',
      event_id: found.id,
      service: found.service,
      start: toISOString(moveTo.start),
      end: toISOString(moveTo.end),
      previous_start: toISOString(found.start),
      summary: found.summary,
      description: found.description,
      next_start: toISOString(earliest),
    };
  }
  const next = others[0];
  return { ok: true, action: 'cancel', event_id: found.id, service: found.service, start: toISOString(found.start), next_start: next ? toISOString(next.start) : null };
}
