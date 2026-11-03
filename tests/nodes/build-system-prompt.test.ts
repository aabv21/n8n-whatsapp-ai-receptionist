import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { run, type PromptInput } from '../../src/nodes/build-system-prompt.ts';
import type { Business } from '../../src/nodes/types.ts';

const tiny = {
  system_prompt: 'B:<<BUSINESS>> K:<<KNOWLEDGE_BASE>> N:<<NOW>> L:<<LANGUAGE>> T:<<TRIAGE_NOTES>>',
  business: { name: 'Cumbident', timezone: 'America/Bogota' } as Business,
  knowledge_base: 'kb', notes: [], now: '2026-11-04T14:05:00Z', team_alerted: false, lang: 'en' as const, lang_detected: true,
};
const build = (input: Partial<PromptInput>): string => run({ ...tiny, ...input }).system_message;

test('fills every placeholder', () => expect(build({})).toBe(
  'B:{\n  "name": "Cumbident",\n  "timezone": "America/Bogota"\n} K:kb N:Wednesday, 2026-11-04 09:05 (America/Bogota) L:The patient is writing in English. T:None.'));
test('joins triage notes one per line', () =>
  expect(build({ notes: ['URGENT: a', 'HANDOFF: b'] })).toMatch(/T:URGENT: a\nHANDOFF: b$/));
test('inserts text verbatim, even with replacement patterns', () =>
  expect(build({ knowledge_base: "Pay $& or $' or $$" })).toContain("K:Pay $& or $' or $$ N:"));
test('real prompt leaves no placeholder unfilled', () => expect(run({
  system_prompt: readFileSync('prompts/system-prompt.md', 'utf8'),
  business: JSON.parse(readFileSync('business/business.json', 'utf8')) as Business,
  knowledge_base: readFileSync('business/knowledge-base.md', 'utf8'), notes: [], now: '2026-11-04T14:05:00Z', team_alerted: false,
  lang: 'es', lang_detected: true,
}).system_message).not.toMatch(/<<[A-Z_]+>>/));
test('a sent team alert adds the TEAM ALERTED note after the triage notes', () =>
  expect(build({ notes: ['HANDOFF: b'], team_alerted: true })).toMatch(
    /T:HANDOFF: b\nTEAM ALERTED: The team has been alerted and will contact the patient soon\. Tell the patient so, and do not call notify_team\.$/));
test('without a sent team alert, only the triage notes are listed', () =>
  expect(build({ notes: ['HANDOFF: b'], team_alerted: false })).toMatch(/T:HANDOFF: b$/));
test('a detected language is passed to the agent as a hint about this message', () =>
  expect(build({ lang: 'es', lang_detected: true })).toContain('L:The patient is writing in Spanish. T:'));
test('an undetected language names the default without claiming the patient wrote in it', () => {
  const prompt = build({ lang: 'es', lang_detected: false });
  expect(prompt).toContain("L:This message doesn't show which language the patient is writing in. If the conversation so far doesn't either, use Spanish, the clinic's default. T:");
  expect(prompt).not.toContain('The patient is writing in');
});
test('a missing or unsupported language falls back to an undetected English hint', () => {
  for (const lang of [undefined, 'fr']) {
    const input = { ...tiny, lang, lang_detected: true } as unknown as PromptInput;
    expect(run(input).system_message, String(lang)).toContain("L:This message doesn't show which language the patient is writing in. If the conversation so far doesn't either, use English, the clinic's default. T:");
  }
});
