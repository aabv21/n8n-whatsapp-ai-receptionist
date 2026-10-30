export type Signal = 'emergency' | 'asks_for_human' | 'complaint' | 'medical_advice' | 'manipulation';
export type Scores = Record<Signal, number>;

export interface RouteInput {
  scores: Scores | null;
  thresholds: Scores;
}

export interface Triage {
  scores: Scores | null;
  route: 'blocked' | 'emergency' | 'handoff' | 'agent';
  flags: { urgent: boolean; handoff: boolean; no_medical_advice: boolean; triage_failed: boolean };
  notify_reason: 'emergency' | 'complaint' | 'human_requested' | null;
  notes: string[];
}

/** Every signal, in the order notes and the accuracy report present them. */
export const SIGNALS: readonly Signal[] = ['emergency', 'asks_for_human', 'complaint', 'medical_advice', 'manipulation'];

const NOTES = {
  urgent:
    'URGENT: The patient may have a dental emergency and the team has been alerted. Offer the first free slot today with check_availability; if today has none, offer the next available day.',
  handoff: 'HANDOFF: The team has been alerted and will contact the patient soon. Tell the patient so, and do not call notify_team.',
  noMedicalAdvice: 'NO MEDICAL ADVICE: Do not give medical advice. Offer an initial evaluation instead.',
} as const;

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Jev answers fail open: `scores` is usable only when every signal is present as a finite number in [0, 1]. */
function isValidScores(scores: Scores): boolean {
  // eslint-disable-next-line security/detect-object-injection -- signal is always one of the fixed Signal literals above
  return SIGNALS.every((signal) => isScore(scores[signal]));
}

/**
 * The one `>=` comparison in the triage contract (Ruling P19): `scripts/lib/scenarios.ts`'s
 * accuracy report reuses this same function instead of re-implementing the threshold rule.
 */
export function meetsThreshold(scores: Scores, thresholds: Scores, signal: Signal): boolean {
  // eslint-disable-next-line security/detect-object-injection -- signal is always one of the fixed Signal literals above
  return scores[signal] >= thresholds[signal];
}

const FAILED_OPEN: Triage = {
  scores: null,
  route: 'agent',
  flags: { urgent: false, handoff: false, no_medical_advice: false, triage_failed: true },
  notify_reason: null,
  notes: [],
};

export function run(input: RouteInput): Triage {
  const { scores } = input;
  if (scores === null || !isValidScores(scores)) return FAILED_OPEN;

  const { thresholds } = input;
  if (meetsThreshold(scores, thresholds, 'manipulation')) {
    return {
      scores,
      route: 'blocked',
      flags: { urgent: false, handoff: false, no_medical_advice: false, triage_failed: false },
      notify_reason: null,
      notes: [],
    };
  }

  const urgent = meetsThreshold(scores, thresholds, 'emergency');
  const asksForHuman = meetsThreshold(scores, thresholds, 'asks_for_human');
  const complaint = meetsThreshold(scores, thresholds, 'complaint');
  const handoff = asksForHuman || complaint;
  const noMedicalAdvice = meetsThreshold(scores, thresholds, 'medical_advice');

  const notes: string[] = [];
  if (urgent) notes.push(NOTES.urgent);
  if (handoff) notes.push(NOTES.handoff);
  if (noMedicalAdvice) notes.push(NOTES.noMedicalAdvice);

  return {
    scores,
    route: urgent ? 'emergency' : handoff ? 'handoff' : 'agent',
    flags: { urgent, handoff, no_medical_advice: noMedicalAdvice, triage_failed: false },
    notify_reason: urgent ? 'emergency' : complaint ? 'complaint' : asksForHuman ? 'human_requested' : null,
    notes,
  };
}
