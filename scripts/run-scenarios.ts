import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Scores } from '../src/nodes/decide-route.ts';
import { callDev } from './lib/dev-client.ts';
import { triageAccuracy, type AccuracyRow, type TriageItem } from './lib/scenarios.ts';

interface LoadContextResult {
  config: { triage: { thresholds: Scores } };
}

interface TriageResult {
  scores: Scores | null;
}

function loadTriageItems(path: string): TriageItem[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is this script's own fixed fixture path, not user input
  return JSON.parse(readFileSync(path, 'utf8')) as TriageItem[];
}

export function formatAccuracyTable(rows: readonly AccuracyRow[]): string {
  const lines = ['| lang | signal | correct/total |', '| --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${row.lang} | ${row.signal} | ${String(row.correct)}/${String(row.total)} |`);
  return lines.join('\n');
}

export async function runTriageScenarios(path: string): Promise<AccuracyRow[]> {
  const items = loadTriageItems(path);
  const { config } = (await callDev('load-context', {})) as LoadContextResult;

  const scores: (Scores | null)[] = [];
  for (const item of items) {
    const result = (await callDev('triage-message', { text: item.text, recent_messages: [] })) as TriageResult;
    scores.push(result.scores);
  }

  return triageAccuracy(items, scores, config.triage.thresholds);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--triage')) {
    console.error('usage: node scripts/run-scenarios.ts --triage');
    process.exitCode = 1;
    return;
  }

  const rows = await runTriageScenarios('tests/scenarios/triage.json');
  console.log(formatAccuracyTable(rows));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
