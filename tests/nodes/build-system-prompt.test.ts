import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { run, type PromptInput } from '../../src/nodes/build-system-prompt.ts';
import type { Business } from '../../src/nodes/types.ts';

const tiny = {
  system_prompt: 'B:<<BUSINESS>> K:<<KNOWLEDGE_BASE>> N:<<NOW>> T:<<TRIAGE_NOTES>>',
  business: { name: 'Cumbident', timezone: 'America/Bogota' } as Business,
  knowledge_base: 'kb', notes: [], now: '2026-11-04T14:05:00Z', team_alerted: false,
};
const build = (input: Partial<PromptInput>): string => run({ ...tiny, ...input }).system_message;

test('fills every placeholder', () => expect(build({})).toBe(
  'B:{\n  "name": "Cumbident",\n  "timezone": "America/Bogota"\n} K:kb N:Wednesday, 2026-11-04 09:05 (America/Bogota) T:None.'));
test('joins triage notes one per line', () =>
  expect(build({ notes: ['URGENT: a', 'HANDOFF: b'] })).toMatch(/T:URGENT: a\nHANDOFF: b$/));
test('inserts text verbatim, even with replacement patterns', () =>
  expect(build({ knowledge_base: "Pay $& or $' or $$" })).toContain("K:Pay $& or $' or $$ N:"));
test('real prompt leaves no placeholder unfilled', () => expect(run({
  system_prompt: readFileSync('prompts/system-prompt.md', 'utf8'),
  business: JSON.parse(readFileSync('business/business.json', 'utf8')) as Business,
  knowledge_base: readFileSync('business/knowledge-base.md', 'utf8'), notes: [], now: '2026-11-04T14:05:00Z', team_alerted: false,
}).system_message).not.toMatch(/<<[A-Z_]+>>/));
test('a sent team alert adds the TEAM ALERTED note after the triage notes', () =>
  expect(build({ notes: ['HANDOFF: b'], team_alerted: true })).toMatch(
    /T:HANDOFF: b\nTEAM ALERTED: The team has been alerted and will contact the patient soon\. Tell the patient so, and do not call notify_team\.$/));
test('without a sent team alert, only the triage notes are listed', () =>
  expect(build({ notes: ['HANDOFF: b'], team_alerted: false })).toMatch(/T:HANDOFF: b$/));
