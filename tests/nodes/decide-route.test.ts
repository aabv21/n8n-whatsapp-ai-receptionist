import { expect, test } from 'vitest';
import { run, type Scores, type Triage } from '../../src/nodes/decide-route.ts';

const thresholds: Scores = { emergency: 0.6, asks_for_human: 0.7, complaint: 0.7, medical_advice: 0.7, manipulation: 0.85 };
const low: Scores = { emergency: 0.1, asks_for_human: 0.1, complaint: 0.1, medical_advice: 0.1, manipulation: 0.1 };
const decide = (scores: Scores | null): Triage => run({ scores, thresholds });

test('missing scores fall back to the agent', () => {
  const r = decide(null);
  expect([r.route, r.flags.triage_failed, r.notify_reason, r.notes]).toEqual(['agent', true, null, []]);
});
test('incomplete or out-of-range scores fail open', () => {
  for (const scores of [{ ...low, manipulation: Number.NaN }, { ...low, complaint: 1.5 }, { emergency: 0.9 } as Scores]) {
    const r = decide(scores);
    expect([r.route, r.flags.triage_failed, r.scores]).toEqual(['agent', true, null]);
  }
});
test('manipulation blocks even with other signals', () =>
  expect(decide({ ...low, manipulation: 0.9, emergency: 0.9 }).route).toBe('blocked'));
test('manipulation just below threshold does not block', () =>
  expect(decide({ ...low, manipulation: 0.84 }).route).toBe('agent'));
test('thresholds are inclusive', () => expect(decide({ ...low, emergency: 0.6 }).route).toBe('emergency'));
test('emergency beats handoff and alerts once as emergency', () => {
  const r = decide({ ...low, emergency: 0.9, asks_for_human: 0.9 });
  expect([r.route, r.notify_reason, r.flags.handoff, r.notes.length]).toEqual(['emergency', 'emergency', true, 2]);
  expect(r.notes[0]).toMatch(/^URGENT:/);
  expect(r.notes[1]).toMatch(/^HANDOFF:/);
});
test('complaint wins the alert reason over a human request', () =>
  expect(decide({ ...low, complaint: 0.8, asks_for_human: 0.8 })).toMatchObject({ route: 'handoff', notify_reason: 'complaint' }));
test('human request routes to handoff', () =>
  expect(decide({ ...low, asks_for_human: 0.75 }).notify_reason).toBe('human_requested'));
test('medical advice only adds a note', () => {
  const r = decide({ ...low, medical_advice: 0.9 });
  expect([r.route, r.flags.no_medical_advice]).toEqual(['agent', true]);
  expect(r.notes[0]).toMatch(/^NO MEDICAL ADVICE:/);
});
test('quiet message goes to the agent with no notes', () =>
  expect(decide(low)).toMatchObject({ route: 'agent', notes: [], flags: { triage_failed: false } }));
