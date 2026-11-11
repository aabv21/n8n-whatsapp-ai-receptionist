import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isEnoent, isExecError } from '../scripts/lib/errors.ts';
import { execFileWithInput, isWebhookLive, waitForWebhookLive } from '../scripts/lib/runtime.ts';

// Proves `input` reaches the child's stdin, which `setup-credentials.ts` relies on to import
// credentials without writing a file. Plain commands stand in for `docker compose`.
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
    // A command that never reads stdin, fed more than a pipe buffer holds, raises EPIPE; without
    // the `stdin.on('error', ...)` handler, Node would crash instead of rejecting.
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

// A fake fetch stands in for n8n's webhook endpoint, so the poll that `pnpm run setup` waits on
// is tested with no network or stack.
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

describe('error guards', () => {
  it('isEnoent and isExecError are defined once, in scripts/lib/errors.ts', () => {
    const files = readdirSync('scripts', { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).map((f) => join('scripts', f));
    for (const name of ['function isEnoent', 'function isExecError']) {
      const defining = files.filter((f) => readFileSync(f, 'utf8').includes(name));
      expect(defining, name).toEqual([join('scripts', 'lib', 'errors.ts')]);
    }
  });

  it("isExecError accepts execFileWithInput's rejection and refuses a plain Error", async () => {
    const rejection: unknown = await execFileWithInput('sh', ['-c', 'exit 1']).catch((err: unknown) => err);
    expect(isExecError(rejection)).toBe(true);
    expect(isExecError(new Error('boom'))).toBe(false);
    expect(isExecError({ stdout: 'only stdout' })).toBe(false);
    expect(isEnoent(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(true);
    expect(isEnoent(new Error('gone'))).toBe(false);
  });
});
