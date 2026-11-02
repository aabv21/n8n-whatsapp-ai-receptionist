import { fileURLToPath } from 'node:url';
import { callDev } from './lib/dev-client.ts';

/**
 * True only when `result` is exactly `{ success: true }` — the Postgres node's own synthesized
 * result for a `DELETE` with nothing left to return (see AGENTS.md's `retention` target). Used
 * by CI to prove the `retention-cleanup` workflow actually ran end to end through n8n — the
 * Postgres path, with no Code node on it (`dev-harness`'s own Code nodes, `Count event/row
 * outcomes`, sit on the `cleanup` target's branch, not this one).
 */
export function isRetentionSuccess(result: unknown): result is { success: true } {
  if (typeof result !== 'object' || result === null) return false;
  const keys = Object.keys(result);
  return keys.length === 1 && (result as Record<string, unknown>).success === true;
}

/**
 * True only when `result` is exactly `{ ok: false, reason: 'past_date' }` — `check-availability`
 * rejecting a date before `Decide whether to call Calendar` ever runs, so no Google credential
 * is needed. This is the one check that proves a *generated* Code node runs: `Check date`
 * (`src/nodes/compute-free-slots.ts`) is what decides `past_date`, before `Get busy events`.
 * A fixed date in the past (`2020-01-06`, a Monday) keeps the result deterministic for any run
 * date from now on.
 */
export function isPastDateRejected(result: unknown): result is { ok: false; reason: 'past_date' } {
  if (typeof result !== 'object' || result === null) return false;
  const keys = Object.keys(result);
  if (keys.length !== 2) return false;
  const r = result as Record<string, unknown>;
  return r.ok === false && r.reason === 'past_date';
}

const CHECKS: readonly { target: string; input: unknown; isExpected: (result: unknown) => boolean }[] = [
  { target: 'retention', input: {}, isExpected: isRetentionSuccess },
  { target: 'check-availability', input: { date: '2020-01-06', phone: '570000000001' }, isExpected: isPastDateRejected },
];

async function main(): Promise<void> {
  for (const { target, input, isExpected } of CHECKS) {
    const result = await callDev(target, input);
    console.log(JSON.stringify({ target, result }, null, 2));
    if (!isExpected(result)) {
      throw new Error(`${target}: unexpected response ${JSON.stringify(result)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
