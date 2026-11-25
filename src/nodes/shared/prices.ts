import type { ToolCall } from '../collect-tool-calls.ts';
import type { Business } from '../types.ts';
import { BOOK_APPOINTMENT_TOOL, toolResults } from './tool-results.ts';

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
export function amounts(text: string): number[] {
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
export function allowedPrices(business: Business, toolCalls: readonly ToolCall[]): Set<number> {
  const prices = new Set(business.services.map((service) => service.price_cop));
  for (const output of toolResults(toolCalls, BOOK_APPOINTMENT_TOOL)) {
    const price = (output as { price_cop?: unknown }).price_cop;
    if (typeof price === 'number') prices.add(price);
  }
  return prices;
}
