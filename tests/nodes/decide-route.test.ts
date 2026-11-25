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
test('no note claims the team was alerted', () => {
  const notes = decide({ ...low, emergency: 0.9, asks_for_human: 0.9, medical_advice: 0.9 }).notes;
  expect(notes).toHaveLength(3);
  for (const note of notes) expect(note).not.toMatch(/alert/i);
});
test('a missing, misspelled, zero, or out-of-range threshold fails the run instead of turning its signal off', () => {
  const message = 'config.triage.thresholds must give every signal a number in (0, 1]';
  const withoutManipulation = Object.fromEntries(Object.entries(thresholds).filter(([signal]) => signal !== 'manipulation'));
  for (const bad of [
    withoutManipulation,
    { ...withoutManipulation, manipulaton: 0.85 },
    { ...thresholds, emergency: 0 },
    { ...thresholds, complaint: 1.2 },
    { ...thresholds, asks_for_human: '0.7' },
  ]) {
    expect(() => run({ scores: low, thresholds: bad as unknown as Scores })).toThrow(message);
  }
});
test('a threshold of exactly 1 is valid', () => expect(run({ scores: low, thresholds: { ...thresholds, manipulation: 1 } }).route).toBe('agent'));
test('a missing thresholds object fails with the same fixed message, not a TypeError', () => {
  for (const missing of [undefined, null]) {
    expect(() => run({ scores: low, thresholds: missing as unknown as Scores })).toThrow('config.triage.thresholds must give every signal a number in (0, 1]');
  }
});

test('the urgent note tells the agent to give the emergency phone when today has no slot', () => {
  expect(decide({ ...low, emergency: 0.9 }).notes[0]).toContain('BUSINESS emergency_phone');
});

test('a complaint alone hands off and alerts as a complaint', () => {
  const r = decide({ ...low, complaint: 0.8 });
  expect([r.route, r.notify_reason, r.flags.handoff]).toEqual(['handoff', 'complaint', true]);
});

// The emergency-only check is how the handoff pause still catches an emergency: Jev answers one
// question, so every other signal is absent, and only the emergency score and threshold count.
test('emergency_only routes on the emergency score alone, ignoring the signals it never asked about', () => {
  const only = (emergency: unknown): Triage => run({ scores: { emergency } as unknown as Scores, thresholds, emergency_only: true });
  expect(only(0.9)).toMatchObject({ route: 'emergency', notify_reason: 'emergency', flags: { urgent: true, triage_failed: false } });
  expect(only(0.9).notes[0]).toMatch(/^URGENT:/);
  expect(only(0.6).route).toBe('emergency');
  expect(only(0.59)).toMatchObject({ route: 'agent', notify_reason: null, notes: [], flags: { urgent: false, triage_failed: false } });
});
test('emergency_only fails open on a missing or invalid emergency score, and still rejects invalid thresholds', () => {
  for (const scores of [null, {}, { emergency: Number.NaN }, { emergency: 2 }] as unknown as (Scores | null)[]) {
    expect(run({ scores, thresholds, emergency_only: true }), JSON.stringify(scores)).toMatchObject({ route: 'agent', flags: { triage_failed: true } });
  }
  expect(() => run({ scores: { emergency: 0.9 } as unknown as Scores, thresholds: { ...thresholds, emergency: 0 }, emergency_only: true })).toThrow(/thresholds/);
});
test('without emergency_only, a lone emergency score still fails open', () =>
  expect(run({ scores: { emergency: 0.9 } as unknown as Scores, thresholds }).flags.triage_failed).toBe(true));
