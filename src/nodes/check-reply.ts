import type { ToolCall } from './collect-tool-calls.ts';
import { bookingConfirmations } from './shared/confirmations.ts';
import { normalizeLocale, pick, type Lang } from './shared/locale.ts';
import { allowedPrices, amounts } from './shared/prices.ts';
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

// NOTE: Patterns, not a classifier: a dose, a dosing interval, or a medicine by generic name,
// Colombian brand, or class, in Spanish or English, so a reply that names a medicine only to refuse
// it is replaced too. Ceiling: a dose in words or an unlisted medicine gets through. Upgrade: a
// second model call that judges the reply; docs/red-team.md lists the remaining limits.
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
