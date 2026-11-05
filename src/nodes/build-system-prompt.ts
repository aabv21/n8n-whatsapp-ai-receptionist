import { TEAM_ALERTED_NOTE } from './decide-route.ts';
import { normalizeLocale, pick, type Lang } from './shared/locale.ts';
import type { Business } from './types.ts';

export interface PromptInput {
  system_prompt: string;
  business: Business;
  knowledge_base: string;
  notes: string[];
  now: string;
  team_alerted: boolean;
  /** This message's language, or the configured default when it couldn't be detected. */
  lang: Lang;
  lang_detected: boolean;
}

const PLACEHOLDER_RE = /<<(BUSINESS|KNOWLEDGE_BASE|NOW|LANGUAGE|TRIAGE_NOTES)>>/g;

const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', es: 'Spanish' };

/**
 * A hint, not an order: the agent still replies in the patient's own language. An undetected
 * language names the default without claiming the patient wrote in it, so a short "ok" never
 * outweighs a conversation that is clearly in the other language.
 */
function languageHint(input: PromptInput): string {
  const lang = normalizeLocale(input.lang);
  if (lang !== null && input.lang_detected) {
    return `The patient is writing in ${pick(LANGUAGE_NAMES, lang)}.`;
  }
  const fallback = pick(LANGUAGE_NAMES, lang ?? 'en');
  return `This message doesn't show which language the patient is writing in. If the conversation so far doesn't either, use ${fallback}, the clinic's default.`;
}

export function run(input: PromptInput): { system_message: string } {
  const zone = input.business.timezone;
  const now = DateTime.fromISO(input.now, { zone, locale: 'en-US' });
  const notes = input.team_alerted ? [...input.notes, TEAM_ALERTED_NOTE] : input.notes;
  const values = new Map<string, string>([
    ['BUSINESS', JSON.stringify(input.business, null, 2)],
    ['KNOWLEDGE_BASE', input.knowledge_base],
    ['NOW', `${now.toFormat('cccc, yyyy-LL-dd HH:mm')} (${zone})`],
    ['LANGUAGE', languageHint(input)],
    ['TRIAGE_NOTES', notes.length > 0 ? notes.join('\n') : 'None.'],
  ]);
  // One pass with a replacer function: its return value is inserted as-is, so `$&`, `$'` and `$$`
  // in the content stay literal, and text inserted for one placeholder is never scanned for another.
  const system_message = input.system_prompt.replace(PLACEHOLDER_RE, (match, name: string) => values.get(name) ?? match);
  return { system_message };
}
