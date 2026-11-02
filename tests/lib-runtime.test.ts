import { describe, expect, it } from 'vitest';
import { execFileWithInput, isWebhookLive, waitForWebhookLive } from '../scripts/lib/runtime.ts';

// `compose()` wraps this with a fixed `docker compose` command, so it's tested here against
// plain commands instead: what's being proven is that `input` really reaches the child
// process's stdin — the mechanism `setup-credentials.ts` relies on to stream a credential
// import without ever writing it to a file. `child_process.execFile`'s promisified form has no
// `input` option (unlike `execFileSync`), which is what regressed when `compose()` was first
// written against it.
describe('execFileWithInput', () => {
  it('writes `input` to the child process stdin and resolves with its stdout', async () => {
    const { stdout } = await execFileWithInput('cat', [], 'hello from stdin\n');
    expect(stdout).toBe('hello from stdin\n');
  });

  it('runs with no stdin at all when input is omitted', async () => {
    const { stdout } = await execFileWithInput('printf', ['ok']);
    expect(stdout).toBe('ok');
  });

  it('rejects with the command stdout and stderr attached when it exits non-zero', async () => {
    await expect(execFileWithInput('sh', ['-c', 'echo out; echo err >&2; exit 3'])).rejects.toMatchObject({
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  it('rejects instead of crashing when the child exits before reading all of stdin (EPIPE)', async () => {
    // A command that exits immediately without reading stdin at all, fed far more input than a
    // pipe buffer holds: the write raises EPIPE. Without the `stdin.on('error', ...)` handler,
    // Node treats that as an unhandled stream error and crashes the process instead of letting
    // this promise reject.
    await expect(execFileWithInput('sh', ['-c', 'exit 0'], 'x'.repeat(10_000_000))).rejects.toThrow();
  });
});

describe('isWebhookLive', () => {
  it('treats 404 as not yet registered', () => expect(isWebhookLive(404)).toBe(false));
  it('treats 403 (the dev harness rejecting an unauthenticated call) as live', () => expect(isWebhookLive(403)).toBe(true));
  it('treats any other status as live too', () => {
    expect(isWebhookLive(200)).toBe(true);
    expect(isWebhookLive(500)).toBe(true);
  });
});

// A fake fetch standing in for n8n's webhook endpoint, so the poll's timing and decision logic
// (live immediately, still-404-then-live, and timeout) are provable with no real network and no
// live stack — the mechanism `import-workflows.ts` relies on to know a publish actually took
// effect before `pnpm run setup` returns.
function fakeFetch(statuses: readonly number[]): typeof fetch {
  let call = 0;
  return ((): Promise<Pick<Response, 'status'>> => {
    const status = statuses[Math.min(call, statuses.length - 1)] ?? 404;
    call += 1;
    return Promise.resolve({ status });
  }) as unknown as typeof fetch;
}

describe('waitForWebhookLive', () => {
  it('returns true right away when the first poll is already live', async () => {
    expect(await waitForWebhookLive('http://n8n.test', 'dev', 5000, fakeFetch([403]))).toBe(true);
  });

  it('returns true once a run of 404s turns live within the budget', async () => {
    expect(await waitForWebhookLive('http://n8n.test', 'dev', 5000, fakeFetch([404, 404, 403]))).toBe(true);
  });

  it('returns false when the budget elapses while every poll still answers 404', async () => {
    expect(await waitForWebhookLive('http://n8n.test', 'dev', 0, fakeFetch([404]))).toBe(false);
  });
});
