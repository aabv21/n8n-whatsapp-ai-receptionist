import type { ToolCall } from '../collect-tool-calls.ts';
import type { Business } from '../types.ts';
import { pick, type Lang } from './locale.ts';
import { BOOK_APPOINTMENT_TOOL, CANCEL_APPOINTMENT_TOOL, RESCHEDULE_APPOINTMENT_TOOL } from './tool-results.ts';

const CONFIRMATIONS: Record<
  Lang,
  {
    locale: string;
    date: string;
    line: (service: string, date: string, at: DateTime) => string;
    moved: (service: string, date: string, at: DateTime) => string;
    cancelled: (service: string, date: string, at: DateTime) => string;
    address: (address: string) => string;
  }
> = {
  en: {
    locale: 'en-US',
    date: 'EEEE, MMMM d, yyyy',
    line: (service, date, at) => `Your appointment is booked: ${service} on ${date} at ${at.toFormat('h:mm a')}.`,
    moved: (service, date, at) => `Your appointment was moved: ${service} on ${date} at ${at.toFormat('h:mm a')}.`,
    cancelled: (service, date, at) => `Your appointment is cancelled: ${service} on ${date} at ${at.toFormat('h:mm a')}.`,
    address: (address) => `Address: ${address}`,
  },
  es: {
    locale: 'es-CO',
    date: "EEEE d 'de' MMMM 'de' yyyy",
    // Spanish says "a la 1" and "a las 2". The abbreviation's own period ends the sentence.
    line: (service, date, at) =>
      `Su cita quedó agendada: ${service}, el ${date} a ${at.hour % 12 === 1 ? 'la' : 'las'} ${at.toFormat('h:mm')} ${at.hour < 12 ? 'a. m.' : 'p. m.'}`,
    moved: (service, date, at) =>
      `Su cita quedó reprogramada: ${service}, el ${date} a ${at.hour % 12 === 1 ? 'la' : 'las'} ${at.toFormat('h:mm')} ${at.hour < 12 ? 'a. m.' : 'p. m.'}`,
    cancelled: (service, date, at) =>
      `Su cita quedó cancelada: ${service}, el ${date} a ${at.hour % 12 === 1 ? 'la' : 'las'} ${at.toFormat('h:mm')} ${at.hour < 12 ? 'a. m.' : 'p. m.'}`,
    address: (address) => `Dirección: ${address}`,
  },
};

/**
 * One fixed line per appointment this turn booked, moved or cancelled, in tool-call order, then one
 * address line when a booking or move made one. Each is built from the tool's own result: its
 * service, by its display name when the price list has one, and its start in the business timezone,
 * in the patient's language. A result without a readable start or service gets no line.
 */
export function bookingConfirmations(business: Business, toolCalls: readonly ToolCall[], lang: Lang): string[] {
  const format = pick(CONFIRMATIONS, lang);
  const lines: string[] = [];
  let hasVisit = false;
  for (const call of toolCalls) {
    const kind =
      call.tool === BOOK_APPOINTMENT_TOOL ? 'line' : call.tool === RESCHEDULE_APPOINTMENT_TOOL ? 'moved' : call.tool === CANCEL_APPOINTMENT_TOOL ? 'cancelled' : null;
    if (!kind || typeof call.output !== 'object' || call.output === null) continue;
    const { ok, start, service } = call.output as { ok?: unknown; start?: unknown; service?: unknown };
    if (ok !== true || typeof start !== 'string' || typeof service !== 'string') continue;
    const at = DateTime.fromISO(start, { setZone: true }).setZone(business.timezone).setLocale(format.locale);
    if (!at.isValid) continue;
    const listed = business.services.find((s) => s.name === service);
    const shown = listed?.name_i18n ? pick(listed.name_i18n, lang) : service;
    const line = kind === 'line' ? format.line : kind === 'moved' ? format.moved : format.cancelled;
    lines.push(line(shown, at.toFormat(format.date), at));
    if (kind !== 'cancelled') hasVisit = true;
  }
  if (hasVisit) lines.push(format.address(business.address));
  return lines;
}
