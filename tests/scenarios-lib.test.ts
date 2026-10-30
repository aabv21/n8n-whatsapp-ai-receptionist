import { DateTime } from 'luxon';
import { expect, test } from 'vitest';
import type { Scores } from '../src/nodes/decide-route.ts';
import { checkTurn, nextWeekday, triageAccuracy, type ProcessResult } from '../scripts/lib/scenarios.ts';

const thresholds: Scores = { emergency: 0.6, asks_for_human: 0.7, complaint: 0.7, medical_advice: 0.7, manipulation: 0.85 };
const low: Scores = { emergency: 0.1, asks_for_human: 0.1, complaint: 0.1, medical_advice: 0.1, manipulation: 0.1 };

test('triage accuracy counts only asserted signals', () => expect(triageAccuracy(
  [{ text: 'a', lang: 'en', expect: { emergency: true } }, { text: 'b', lang: 'es', expect: { emergency: false, complaint: false } }],
  [{ ...low, emergency: 0.9 }, null], thresholds,
)).toEqual([
  { lang: 'en', signal: 'emergency', correct: 1, total: 1 },
  { lang: 'es', signal: 'emergency', correct: 0, total: 1 },
  { lang: 'es', signal: 'complaint', correct: 0, total: 1 },
]));

const result: ProcessResult = { reply: 'I have 09:30 on Thursday', route: 'agent', flags: {},
  tool_calls: [{ tool: 'check_availability', input: { date: '2026-11-05' }, output: { ok: true } }] };

test('next weekday is the first one after today in Bogota', () => {
  const thursdayAfter = (iso: string): string => nextWeekday(DateTime.fromISO(iso), 4);
  expect(thursdayAfter('2026-11-04T10:00:00-05:00')).toBe('2026-11-05');
  expect(thursdayAfter('2026-11-05T10:00:00-05:00')).toBe('2026-11-12');
  expect(thursdayAfter('2026-11-05T02:00:00Z')).toBe('2026-11-05');
});
test('a turn passes when every expectation holds', () => expect(checkTurn({
  route: 'agent', tools_include: ['check_availability'], tools_exclude: ['book_appointment'], reply_matches: ['THURSDAY'],
  tool_input: { tool: 'check_availability', field: 'date', equals: '2026-11-05' },
  tool_output: [{ tool: 'check_availability', field: 'ok', equals: true }],
}, result)).toEqual([]));
test('each failed expectation is reported', () => expect(checkTurn(
  { route: 'handoff', tools_exclude: ['check_availability'], reply_matches: ['friday'] }, result)).toHaveLength(3));
