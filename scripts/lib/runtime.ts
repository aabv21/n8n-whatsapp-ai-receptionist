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
 * Runs `command args`, writing `input` to stdin when given: promisified `execFile` has no `input`
 * option, unlike `execFileSync`. Separate from `compose()` so the stdin wiring is testable
 * without Docker.
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
    if (input !== undefined) {
      // Writing more than the child reads raises EPIPE, and an unhandled stream 'error' crashes
      // the process, so reject instead.
      child.stdin?.on('error', (err: Error) => {
        reject(Object.assign(err, { stdout: '', stderr: '' }));
      });
      child.stdin?.end(input);
    }
  });
}

/** Runs `docker compose <args>`. `input`, when given, is piped to the process's stdin; see `execFileWithInput`. */
export function compose(args: readonly string[], input?: string): Promise<{ stdout: string; stderr: string }> {
  return execFileWithInput('docker', ['compose', ...args], input);
}

export interface PsqlOptions {
  /** The environment variable holding the role to connect as, expanded inside the container. */
  role: 'POSTGRES_USER' | 'APP_RUNTIME_DB_USER';
  database: 'app' | 'n8n';
  /** Variables the script reads with `\getenv`, forwarded by name from this process's environment. */
  forwardEnv: readonly string[];
  singleTransaction: boolean;
}

/**
 * The `compose()` arguments that run psql in the `postgres` container over its local socket,
 * reading the script from stdin. Each `forwardEnv` name goes as a bare `-e NAME`, so Docker copies
 * the value from this process's environment: it never reaches an argument list, and a changed
 * `.env` applies without recreating the container.
 */
export function psqlArgs({ role, database, forwardEnv, singleTransaction }: PsqlOptions): string[] {
  const transaction = singleTransaction ? ' --single-transaction' : '';
  const psql = `psql -X -q -A -t -v ON_ERROR_STOP=1${transaction} -U "$${role}" -d ${database} -f -`;
  return ['exec', '-T', ...forwardEnv.flatMap((name) => ['-e', name]), 'postgres', 'sh', '-c', psql];
}

export interface PsqlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function hasOutput(err: unknown): err is { stdout: string; stderr: string } {
  return typeof err === 'object' && err !== null && typeof (err as { stdout?: unknown }).stdout === 'string';
}

/** Runs `sql` through psql with `options`. A psql failure resolves with `ok: false` and its output, instead of throwing. */
export async function runPsql(options: PsqlOptions, sql: string): Promise<PsqlResult> {
  try {
    const { stdout, stderr } = await compose(psqlArgs(options), sql);
    return { ok: true, stdout, stderr };
  } catch (err) {
    if (hasOutput(err)) return { ok: false, stdout: err.stdout, stderr: err.stderr };
    throw err;
  }
}

/** The non-empty values of every variable in `env` whose name ends in `PASSWORD`, `SECRET`, `TOKEN`, or `KEY`. */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => /(PASSWORD|SECRET|TOKEN|KEY)$/.test(name) && value !== undefined && value !== '')
    .map(([, value]) => value ?? '');
}

/** `text` with every occurrence of each secret replaced, for output that may echo a statement. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.filter((secret) => secret !== '').reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text);
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
 * `isWebhookLive` or `budgetMs` elapses. After the restart that applies `publish:workflow`, the
 * publication reconciler registers the route on its own schedule (10 s by default), so it can
 * still 404 after `/healthz` is healthy. The dev harness answers 403 without `X-Dev-Token` once
 * live, so this needs no credential. `fetchImpl` is injectable for tests.
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
