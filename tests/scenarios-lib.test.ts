import { expect, test } from 'vitest';
import type { Scores } from '../src/nodes/decide-route.ts';
import { triageAccuracy } from '../scripts/lib/scenarios.ts';

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
