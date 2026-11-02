import { execFile } from 'node:child_process';

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

/** Loads `.env` into `process.env`. Fails with a pointer to `.env.example` if it's missing. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    if (isEnoent(err)) throw new Error('.env not found; copy .env.example to .env and fill in local values.', { cause: err });
    throw err;
  }
}

/**
 * Runs `command args`. `input`, when given, is written to the child process's stdin and the
 * stream is then closed — `child_process.execFile`'s own promisified form has no `input` option
 * (unlike `execFileSync`), so stdin is wired by hand here. Kept separate from `compose()` below
 * so the stdin-wiring itself can be tested against a real, trivial command, with no `docker`
 * dependency.
 */
export function execFileWithInput(command: string, args: readonly string[], input?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024 }, (err: Error | null, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Runs `docker compose <args>`. `input`, when given, is piped to the process's stdin; see `execFileWithInput`. */
export function compose(args: readonly string[], input?: string): Promise<{ stdout: string; stderr: string }> {
  return execFileWithInput('docker', ['compose', ...args], input);
}

/** Polls `${baseUrl}/healthz` once a second until it responds OK or `budgetMs` elapses. */
export async function waitForHealthy(baseUrl: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      // not up yet; retry below until the budget runs out
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}

/** True once a status means the webhook is registered and live — anything but 404 (n8n's "not found" for an unknown path). */
export function isWebhookLive(status: number): boolean {
  return status !== 404;
}

/**
 * Polls `${baseUrl}/webhook/${path}` with an unauthenticated POST, once a second, until
 * `isWebhookLive` is true or `budgetMs` elapses. `publish:workflow` only takes effect after an
 * n8n restart, and the publication reconciler that actually registers the webhook route runs on
 * its own schedule after that (10 s by default) — so a call made right after `/healthz` turns
 * healthy can still 404 for a few more seconds. The dev harness's webhook checks `X-Dev-Token`
 * before running anything, so an unauthenticated request answers 403 once it's live — the
 * cheapest possible proof the publish actually took effect, with no credential needed.
 * `fetchImpl` is injectable so the polling logic can be unit-tested with no real network.
 */
export async function waitForWebhookLive(
  baseUrl: string,
  path: string,
  budgetMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const res = await fetchImpl(`${baseUrl}/webhook/${path}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (isWebhookLive(res.status)) return true;
    } catch {
      // not registered yet, or n8n isn't reachable for a moment; retry below until the budget runs out
    }
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}
