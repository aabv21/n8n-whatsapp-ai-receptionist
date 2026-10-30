import { meetsThreshold, SIGNALS, type Scores, type Signal } from '../../src/nodes/decide-route.ts';

export interface TriageItem {
  text: string;
  lang: 'en' | 'es';
  expect: Partial<Record<Signal, boolean>>;
}

export interface AccuracyRow {
  lang: 'en' | 'es';
  signal: Signal;
  correct: number;
  total: number;
}

const LANGS: readonly ('en' | 'es')[] = ['en', 'es'];

/**
 * Scores each item's asserted signals against `thresholds`, reusing decide-route's own `>=` rule
 * (Ruling P19) so the accuracy report can never drift from the routing logic it's grading. A
 * `null` score (Jev failed or answered incompletely) always counts as wrong, whatever the item
 * expects — there's no reading to compare, so it can't count as a match either way.
 */
export function triageAccuracy(items: readonly TriageItem[], scores: readonly (Scores | null)[], thresholds: Scores): AccuracyRow[] {
  const rows = new Map<string, AccuracyRow>();

  items.forEach((item, index) => {
    // eslint-disable-next-line security/detect-object-injection -- index is this loop's own array position, not user input
    const itemScores = scores[index] ?? null;
    for (const signal of SIGNALS) {
      // eslint-disable-next-line security/detect-object-injection -- signal is always one of the fixed Signal literals from SIGNALS
      const expected = item.expect[signal];
      if (expected === undefined) continue;

      const key = `${item.lang}:${signal}`;
      const row = rows.get(key) ?? { lang: item.lang, signal, correct: 0, total: 0 };
      row.total += 1;
      if (itemScores !== null && meetsThreshold(itemScores, thresholds, signal) === expected) row.correct += 1;
      rows.set(key, row);
    }
  });

  const ordered: AccuracyRow[] = [];
  for (const lang of LANGS) {
    for (const signal of SIGNALS) {
      const row = rows.get(`${lang}:${signal}`);
      if (row && row.total > 0) ordered.push(row);
    }
  }
  return ordered;
}
