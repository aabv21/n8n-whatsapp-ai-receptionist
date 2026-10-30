import { TEAM_ALERTED_NOTE } from './decide-route.ts';
import type { Business } from './types.ts';

export interface PromptInput {
  system_prompt: string;
  business: Business;
  knowledge_base: string;
  notes: string[];
  now: string;
  team_alerted: boolean;
}

const PLACEHOLDER_RE = /<<(BUSINESS|KNOWLEDGE_BASE|NOW|TRIAGE_NOTES)>>/g;

export function run(input: PromptInput): { system_message: string } {
  const zone = input.business.timezone;
  const now = DateTime.fromISO(input.now, { zone, locale: 'en-US' });
  const notes = input.team_alerted ? [...input.notes, TEAM_ALERTED_NOTE] : input.notes;
  const values = new Map<string, string>([
    ['BUSINESS', JSON.stringify(input.business, null, 2)],
    ['KNOWLEDGE_BASE', input.knowledge_base],
    ['NOW', `${now.toFormat('cccc, yyyy-LL-dd HH:mm')} (${zone})`],
    ['TRIAGE_NOTES', notes.length > 0 ? notes.join('\n') : 'None.'],
  ]);
  // One pass with a replacer function: its return value is inserted as-is, so `$&`, `$'` and `$$`
  // in the content stay literal, and text inserted for one placeholder is never scanned for another.
  const system_message = input.system_prompt.replace(PLACEHOLDER_RE, (match, name: string) => values.get(name) ?? match);
  return { system_message };
}
