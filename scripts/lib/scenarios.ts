import { DateTime } from 'luxon';
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
 * so the accuracy report can never drift from the routing logic it's grading. A
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

export interface TurnExpect {
  route?: string;
  tools_include?: string[];
  tools_exclude?: string[];
  reply_matches?: string[];
  tool_input?: { tool: string; field: string; equals: string };
  tool_output?: { tool: string; field: string; equals: unknown }[];
}

export interface Scenario {
  id: string;
  phone: string;
  requires_open_tomorrow?: boolean;
  turns: { text: string; expect: TurnExpect }[];
  after?: { patient_rows: { phone: string; count: number }[] };
}

export interface ProcessResult {
  reply: string | null;
  route: string;
  flags: Record<string, boolean>;
  tool_calls: { tool: string; input: unknown; output: unknown }[];
}

export const BOGOTA = 'America/Bogota';
const THURSDAY = 4;

/**
 * The first `weekday` (Luxon's 1 = Monday .. 7 = Sunday) strictly after today in America/Bogota —
 * "today" there, whatever zone `now` itself was built in, since an instant converts cleanly.
 */
export function nextWeekday(now: DateTime, weekday: number): string {
  let day = now.setZone(BOGOTA).plus({ days: 1 });
  while (day.weekday !== weekday) day = day.plus({ days: 1 });
  return day.toFormat('yyyy-LL-dd');
}

/**
 * Replaces every `{{next_thursday}}` token inside `value`, at any depth, with that date. A JSON
 * round-trip does the deep walk, since every scenario fixture is JSON-shaped to begin with.
 */
export function resolveTokens<T>(value: T, now: DateTime): T {
  const serialized = JSON.stringify(value).replaceAll('{{next_thursday}}', nextWeekday(now, THURSDAY));
  return JSON.parse(serialized) as T;
}

/** The named top-level field of a tool call's `input` or `output`, both declared as `unknown`. */
// eslint-disable-next-line security/detect-object-injection -- key names a fixture-declared top-level field, not user input
const topLevelField = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined);

function firstCall(tool_calls: ProcessResult['tool_calls'], tool: string): ProcessResult['tool_calls'][number] | undefined {
  return tool_calls.find((call) => call.tool === tool);
}

/** One message per failed expectation in `expect`; `[]` means every one of them held. */
export function checkTurn(expect: TurnExpect, result: ProcessResult): string[] {
  const failures: string[] = [];
  const calledTools = result.tool_calls.map((call) => call.tool);

  if (expect.route !== undefined && result.route !== expect.route) {
    failures.push(`route: expected "${expect.route}", got "${result.route}"`);
  }

  if (expect.tools_include) {
    const missing = expect.tools_include.filter((tool) => !calledTools.includes(tool));
    if (missing.length > 0) failures.push(`tools_include: ${missing.join(', ')} not called`);
  }

  if (expect.tools_exclude) {
    const unexpected = expect.tools_exclude.filter((tool) => calledTools.includes(tool));
    if (unexpected.length > 0) failures.push(`tools_exclude: ${unexpected.join(', ')} was called`);
  }

  if (expect.reply_matches) {
    const reply = result.reply ?? '';
    const missed = expect.reply_matches.filter((pattern) => {
      // eslint-disable-next-line security/detect-non-literal-regexp -- patterns come from the repo's own scenario fixture file
      return !new RegExp(pattern, 'i').test(reply);
    });
    if (missed.length > 0) failures.push(`reply_matches: missing ${missed.join(', ')}`);
  }

  if (expect.tool_input) {
    const { tool, field, equals } = expect.tool_input;
    const call = firstCall(result.tool_calls, tool);
    if (!call) failures.push(`tool_input: ${tool} was not called`);
    else {
      const actual = topLevelField(call.input, field);
      if (actual !== equals) failures.push(`tool_input: ${tool}.${field} expected ${JSON.stringify(equals)}, got ${JSON.stringify(actual)}`);
    }
  }

  if (expect.tool_output) {
    for (const { tool, field, equals } of expect.tool_output) {
      const call = firstCall(result.tool_calls, tool);
      if (!call) {
        failures.push(`tool_output: ${tool} was not called`);
        continue;
      }
      const actual = topLevelField(call.output, field);
      if (actual !== equals) failures.push(`tool_output: ${tool}.${field} expected ${JSON.stringify(equals)}, got ${JSON.stringify(actual)}`);
    }
  }

  return failures;
}
