import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import type { Scores } from '../src/nodes/decide-route.ts';
import { callDev } from './lib/dev-client.ts';
import { BOGOTA, checkTurn, resolveTokens, triageAccuracy, type AccuracyRow, type ProcessResult, type Scenario, type TriageItem } from './lib/scenarios.ts';

const CLEANUP_PREFIX = '5700000000';
const CONFIG_PATH = 'config/config.json';
const CONFIG_BACKUP_PATH = 'config/config.json.bak';
const CONFIG_TMP_PATH = 'config/config.json.tmp';
const CONVERSATIONS_PATH = 'tests/scenarios/conversations.json';
const TRIAGE_PATH = 'tests/scenarios/triage.json';

interface LoadContextResult {
  config: { triage: { thresholds: Scores } };
}

interface TriageResult {
  scores: Scores | null;
}

interface FindPatientResult {
  rows: unknown[];
}

function loadTriageItems(path: string): TriageItem[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is this script's own fixed fixture path, not user input
  return JSON.parse(readFileSync(path, 'utf8')) as TriageItem[];
}

function loadConversationScenarios(path: string): Scenario[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is this script's own fixed fixture path, not user input
  return JSON.parse(readFileSync(path, 'utf8')) as Scenario[];
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

export interface ConversationRow {
  id: string;
  result: 'PASS' | 'FAIL' | 'SKIP';
  details: string;
}

export function formatConversationTable(rows: readonly ConversationRow[]): string {
  const lines = ['| id | result | details |', '| --- | --- | --- |'];
  for (const row of rows) lines.push(`| ${row.id} | ${row.result} | ${row.details} |`);
  return lines.join('\n');
}

function isTomorrowSunday(now: DateTime): boolean {
  return now.setZone(BOGOTA).plus({ days: 1 }).weekday === 7;
}

async function cleanup(label: string): Promise<void> {
  const result = await callDev('cleanup', { phone_prefix: CLEANUP_PREFIX });
  console.log(`cleanup (${label}): ${JSON.stringify(result)}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A dev-harness call that throws still reports as this scenario's FAIL, instead of aborting the
 * batch and skipping the closing cleanup. Offline, `find-patient` has no failure shape of its own
 * and throws without a live Sheets credential, so every `after` check fails this way.
 */
export async function runScenario(scenario: Scenario, now: DateTime): Promise<ConversationRow> {
  if (scenario.requires_open_tomorrow === true && isTomorrowSunday(now)) {
    return { id: scenario.id, result: 'SKIP', details: 'tomorrow is Sunday in America/Bogota' };
  }

  const resolved = resolveTokens(scenario, now);
  const failures: string[] = [];

  try {
    for (const [index, turn] of resolved.turns.entries()) {
      const result = (await callDev('process-message', {
        channel: 'test',
        message_id: `t-${resolved.id}-${String(index + 1)}-${String(Date.now())}`,
        phone: resolved.phone,
        name: null,
        type: 'text',
        text: turn.text,
        received_at: DateTime.now().toISO(),
      })) as ProcessResult;

      for (const failure of checkTurn(turn.expect, result)) failures.push(`turn ${String(index + 1)}: ${failure}`);
    }
  } catch (err) {
    failures.push(`process-message failed: ${errorMessage(err)}`);
  }

  if (resolved.after) {
    try {
      for (const expected of resolved.after.patient_rows) {
        const { rows } = (await callDev('find-patient', { phone: expected.phone })) as FindPatientResult;
        if (rows.length !== expected.count) failures.push(`after: ${expected.phone} expected ${String(expected.count)} row(s), got ${String(rows.length)}`);
      }
    } catch (err) {
      failures.push(`find-patient failed: ${errorMessage(err)}`);
    }
  }

  return { id: scenario.id, result: failures.length > 0 ? 'FAIL' : 'PASS', details: failures.length > 0 ? failures.join('; ') : '-' };
}

export async function runConversationScenarios(scenarios: readonly Scenario[], now: DateTime): Promise<ConversationRow[]> {
  const rows: ConversationRow[] = [];
  for (const scenario of scenarios) rows.push(await runScenario(scenario, now));
  return rows;
}

/** Lives here, not in conversations.json: it rewrites config/config.json, so it only runs under `--tool-failure`, never the full suite. */
const TOOL_FAILURE_SCENARIO: Scenario = {
  id: 'tool-failure',
  phone: '570000000022',
  turns: [
    {
      text: 'Do you have any openings next Wednesday?',
      expect: {
        tool_output: [
          { tool: 'check_availability', field: 'reason', equals: 'calendar_unavailable' },
          { tool: 'check_availability', field: 'team_notified', equals: true },
        ],
        reply_matches: ['(sorry|apolog)'],
      },
    },
  ],
};

/**
 * n8n reads `config/config.json` through a bind mount on every execution, so this never edits it
 * in place: `writeFileSync` truncates first, and a reader in between would see partial JSON. The
 * original lives in an on-disk `.bak`, never only in memory, so even a SIGINT that skips `finally`
 * leaves it recoverable.
 */
export async function runToolFailureScenario(now: DateTime): Promise<ConversationRow> {
  copyFileSync(CONFIG_PATH, CONFIG_BACKUP_PATH);
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { google: { calendar_id: string } };
    config.google.calendar_id = 'invalid-test-calendar@example.com';
    writeFileSync(CONFIG_TMP_PATH, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(CONFIG_TMP_PATH, CONFIG_PATH);

    await cleanup('before');
    const row = await runScenario(TOOL_FAILURE_SCENARIO, now);
    await cleanup('after');
    return row;
  } finally {
    renameSync(CONFIG_BACKUP_PATH, CONFIG_PATH);
  }
}

function usage(): void {
  console.error('usage: node scripts/run-scenarios.ts [--triage | --only <id> | --tool-failure]');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const now = DateTime.now();

  if (args.includes('--tool-failure')) {
    if (existsSync(CONFIG_BACKUP_PATH)) {
      console.error(`${CONFIG_BACKUP_PATH} already exists: an earlier --tool-failure run didn't finish.`);
      console.error(`Restore it with: mv ${CONFIG_BACKUP_PATH} ${CONFIG_PATH} (or delete ${CONFIG_BACKUP_PATH} if ${CONFIG_PATH} already looks right).`);
      process.exitCode = 1;
      return;
    }

    const row = await runToolFailureScenario(now);
    console.log(formatConversationTable([row]));
    if (row.result === 'FAIL') process.exitCode = 1;
    return;
  }

  if (args.includes('--triage')) {
    console.log(formatAccuracyTable(await runTriageScenarios(TRIAGE_PATH)));
    return;
  }

  const onlyIndex = args.indexOf('--only');
  if (onlyIndex !== -1) {
    const id = args[onlyIndex + 1];
    const scenario = id ? loadConversationScenarios(CONVERSATIONS_PATH).find((s) => s.id === id) : undefined;
    if (!id || !scenario) {
      console.error(id ? `unknown scenario id: ${id}` : 'missing <id> after --only');
      process.exitCode = 1;
      return;
    }

    await cleanup('before');
    const row = await runScenario(scenario, now);
    await cleanup('after');
    console.log(formatConversationTable([row]));
    if (row.result === 'FAIL') process.exitCode = 1;
    return;
  }

  if (args.length > 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  console.log(formatAccuracyTable(await runTriageScenarios(TRIAGE_PATH)));

  await cleanup('before');
  const rows = await runConversationScenarios(loadConversationScenarios(CONVERSATIONS_PATH), now);
  await cleanup('after');
  console.log(formatConversationTable(rows));
  if (rows.some((row) => row.result === 'FAIL')) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
