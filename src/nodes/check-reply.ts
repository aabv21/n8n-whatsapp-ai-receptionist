import type { ToolCall } from './collect-tool-calls.ts';
import { normalizeLocale, pick, type Lang } from './shared/locale.ts';
import type { Business } from './types.ts';

export interface ReplyCheckInput {
  reply: string;
  flags: Record<string, boolean>;
  tool_calls: ToolCall[];
  business: Business;
  /** The patient's language, from process-message's Resolve language; anything else falls back to English. */
  lang: Lang;
}

export interface ReplyCheck {
  reply: string;
  flags: Record<string, boolean>;
}

// NOTE: These are patterns, not a classifier. They catch a dose, a dosing interval, or a medicine
// named by its generic name, a brand sold in Colombia, or its class, in Spanish or English, so a
// reply that only mentions a medicine to refuse it is replaced too (with a reply that also
// refuses). A dose written out in words, or a medicine not on this list, gets through. The upgrade
// is a second model call that judges the reply; docs/red-team.md lists the remaining limits.
const MEDICAL_PATTERNS: readonly RegExp[] = [
  /\d\s?(?:mg|ml)(?!\p{L})/iu,
  /\bcada\s+\d+\s?h(?:oras|ora|rs|r)?(?!\p{L})/iu,
  /\bevery\s+\d+\s?h(?:ours|our|rs|r)?(?!\p{L})/iu,
  /\b(?:ibuprofeno?|amoxicilina|amoxicillin|acetaminof[eé]n|acetaminophen|paracetamol|naproxeno?|diclofenaco?|aspirin(?:a|as)?|nimesulid[ae]|ketorolaco?|metamizole?|dipirona|tramadol|code[ií]na|codeine|penicilinas?|penicillin|clindamicina|clindamycin|metronidazole?|azitromicina|azithromycin)(?!\p{L})/iu,
  /\b(?:dolex|advil|tylenol|buscapina|noxpirin|ibuflash|apronax|voltaren|aleve|motrin|ponstan|winadeine)(?!\p{L})/iu,
  /\b(?:analg[eé]sicos?|analgesics?|antibi[oó]ticos?|antibiotics?|antiinflamatorios?|anti-?inflammator(?:y|ies))(?!\p{L})/iu,
];

// A discount the price list doesn't have: a percentage off, in Spanish or English.
const DISCOUNT_PATTERNS: readonly RegExp[] = [
  /\d\s?%\s*(?:de\s)?\s*descuento/iu,
  /\bdescuentos?\s+del?\s+\d/iu,
  /\d\s?%\s*(?:off|discount)(?!\p{L})/iu,
  /\bdiscount\s+of\s+\d/iu,
];

// A number as written: digits, dots, and commas. Only a currency marker beside it makes it an amount.
const NUMBER_RE = /\d[\d.,]*/g;
// Thousands grouped by a space (`120 000`), rewritten as `120.000` before numbers are read.
const SPACED_THOUSANDS_RE = /(\d)[ \u00A0\u202F](?=\d{3}(?!\d))/g;
const CURRENCY_BEFORE_RE = /(?:\$|\bCOP)\s?$/i;
const CURRENCY_AFTER_RE = /^\s?(?:COP|pesos)(?!\p{L})/iu;
const MULTIPLIER_AFTER_RE = /^\s?(mil|k|mill[oó]n|mill[oó]nes)(?!\p{L})/iu;

/**
 * The value of a thousands-grouped number (`450.000`, `1,200,000`, `450.000,00`), or null for
 * anything else, such as a time (`08:00`), a date, or a decimal (`1.5`).
 */
function groupedValue(token: string): number | null {
  const parts = token.split(/[.,]/);
  if (parts.length > 2 && parts.at(-1)?.length === 2) parts.pop(); // cents
  const [head = '', ...groups] = parts;
  if (groups.length === 0 || !/^\d{1,3}$/.test(head) || !groups.every((group) => /^\d{3}$/.test(group))) return null;
  return Number(head + groups.join(''));
}

/** A grouped number, a whole number, or a decimal with one or two places (`1,2` in `1,2 millones`). */
function numberValue(token: string): number | null {
  const grouped = groupedValue(token);
  if (grouped !== null) return grouped;
  if (/^\d+$/.test(token)) return Number(token);
  if (/^\d+[.,]\d{1,2}$/.test(token)) return Number(token.replace(',', '.'));
  return null;
}

/**
 * Every peso amount in `text`: a number with `$` or `COP` before it, `COP` or `pesos` after it, or
 * a multiplier after it (`mil` and `k` for thousands, `millón` or `millones` for millions). A
 * number with none of these, such as a time, a date, an age, or "2.000 pacientes", never counts.
 */
function amounts(text: string): number[] {
  const normalized = text.replace(SPACED_THOUSANDS_RE, '$1.');
  const found: number[] = [];
  for (const match of normalized.matchAll(NUMBER_RE)) {
    const token = match[0].replace(/[.,]+$/, ''); // the sentence's own period or comma
    const value = numberValue(token);
    if (value === null) continue;
    const before = normalized.slice(Math.max(0, match.index - 5), match.index);
    const after = normalized.slice(match.index + token.length);
    const multiplier = MULTIPLIER_AFTER_RE.exec(after)?.[1]?.toLowerCase();
    if (multiplier !== undefined) found.push(Math.round(value * (multiplier === 'mil' || multiplier === 'k' ? 1_000 : 1_000_000)));
    else if (CURRENCY_BEFORE_RE.test(before) || CURRENCY_AFTER_RE.test(after)) found.push(value);
  }
  return found;
}

/** The listed prices, plus the price a `book_appointment` call returned this turn. */
function allowedPrices(business: Business, toolCalls: readonly ToolCall[]): Set<number> {
  const prices = new Set(business.services.map((service) => service.price_cop));
  for (const call of toolCalls) {
    const output = call.output;
    if (call.tool !== 'book_appointment' || typeof output !== 'object' || output === null) continue;
    const price = (output as { price_cop?: unknown }).price_cop;
    if (typeof price === 'number') prices.add(price);
  }
  return prices;
}

/** The booking confirmation line, with its date and time written the way each language reads them. */
const CONFIRMATIONS: Record<Lang, { locale: string; date: string; time: string; line: (service: string, date: string, time: string) => string }> = {
  en: {
    locale: 'en-US',
    date: 'EEEE, MMMM d, yyyy',
    time: 'h:mm a',
    line: (service, date, time) => `Your appointment is booked: ${service} on ${date} at ${time}.`,
  },
  es: {
    locale: 'es-CO',
    date: "EEEE d 'de' MMMM 'de' yyyy",
    time: 'H:mm',
    line: (service, date, time) => `Su cita quedó agendada: ${service}, el ${date} a las ${time}.`,
  },
};

/**
 * One fixed line per appointment a `book_appointment` call booked this turn, from that tool's own
 * result: its service, by its display name when the price list has one, and its start's date and
 * time in the business timezone, in the patient's language. A result without a readable start or service gets no line.
 */
function bookingConfirmations(business: Business, toolCalls: readonly ToolCall[], lang: Lang): string[] {
  const format = pick(CONFIRMATIONS, lang);
  const lines: string[] = [];
  for (const call of toolCalls) {
    const output = call.output;
    if (call.tool !== 'book_appointment' || typeof output !== 'object' || output === null) continue;
    const { ok, start, service } = output as { ok?: unknown; start?: unknown; service?: unknown };
    if (ok !== true || typeof start !== 'string' || typeof service !== 'string') continue;
    const at = DateTime.fromISO(start, { setZone: true }).setZone(business.timezone).setLocale(format.locale);
    if (!at.isValid) continue;
    const listed = business.services.find((s) => s.name === service);
    const shown = listed?.name_i18n ? pick(listed.name_i18n, lang) : service;
    lines.push(format.line(shown, at.toFormat(format.date), at.toFormat(format.time)));
  }
  return lines;
}

/**
 * Checks the agent's reply before it reaches the patient. A dose or a medicine is replaced with
 * the fixed `medical_advice` reply, and a discount or a peso amount that isn't a listed price
 * with the fixed `price_check` reply, both in the patient's language; either sets
 * `flags.reply_replaced`. A replaced reply still confirms any booking this turn made, so the
 * patient never loses the news that it went through.
 */
export function run(input: ReplyCheckInput): ReplyCheck {
  const { reply, business } = input;
  const lang = normalizeLocale(input.lang) ?? 'en';
  let replacement: string | null = null;
  if (MEDICAL_PATTERNS.some((pattern) => pattern.test(reply))) {
    replacement = pick(business.replies.medical_advice, lang);
  } else if (DISCOUNT_PATTERNS.some((pattern) => pattern.test(reply))) {
    replacement = pick(business.replies.price_check, lang);
  } else {
    const allowed = allowedPrices(business, input.tool_calls);
    if (amounts(reply).some((amount) => !allowed.has(amount))) replacement = pick(business.replies.price_check, lang);
  }
  if (replacement === null) return { reply, flags: { ...input.flags, reply_replaced: false } };
  const confirmations = bookingConfirmations(business, input.tool_calls, lang);
  return {
    reply: confirmations.length > 0 ? `${replacement}\n\n${confirmations.join('\n')}` : replacement,
    flags: { ...input.flags, reply_replaced: true },
  };
}
