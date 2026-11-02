import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EXAMPLE_PATH = '.env.example';
const ENV_PATH = '.env';
const N8N_IMPORT_DIR = '.n8n-import';

// Names this repo's `.env.example` leaves blank that the local stack and the credential-free
// dev-harness target (`retention`) still need a real value for: Postgres's three roles, n8n's
// own encryption key, and the dev-harness header token. Everything else blank in the example
// (Google, WhatsApp, Anthropic, TypeSafe, ngrok) stays blank — generating those would make a
// workflow that needs a real third-party credential look configured when it isn't.
const GENERATED_NAMES = new Set([
  'POSTGRES_PASSWORD',
  'N8N_DB_PASSWORD',
  'APP_DB_PASSWORD',
  'N8N_ENCRYPTION_KEY',
  'DEV_HARNESS_TOKEN',
]);

function defaultRandomHex(): string {
  return randomBytes(32).toString('hex');
}

/** Fills only `GENERATED_NAMES`' empty values. Comments, blank lines, and every other value are kept as-is, in order. */
export function fillSecrets(example: string, randomHex: () => string = defaultRandomHex): string {
  return example
    .split('\n')
    .map((line) => {
      const match = /^([A-Z0-9_]+)=$/.exec(line);
      if (!match) return line;
      const name = match[1];
      if (name === undefined || !GENERATED_NAMES.has(name)) return line;
      return `${name}=${randomHex()}`;
    })
    .join('\n');
}

/**
 * Writes `.env` text atomically at mode 0600. `.env` holds `N8N_ENCRYPTION_KEY`; a write
 * interrupted partway through must never leave a truncated file, which would lose every stored
 * n8n credential. Writes to a tmp file first, then renames it over the target in one step. The
 * tmp file is chmod'd 0600 explicitly, because a crashed prior run can leave it behind at
 * whatever looser mode it was created with, and `writeFileSync`'s own `{ mode }` option only
 * applies when the file doesn't already exist.
 */
export function writeEnvFile(path: string, text: string): void {
  const tmpPath = `${path}.tmp`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is the caller-provided .env path, not user input
  writeFileSync(tmpPath, text, { mode: 0o600 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is the caller-provided .env path, not user input
  chmodSync(tmpPath, 0o600);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is the caller-provided .env path, not user input
  renameSync(tmpPath, path);
}

/**
 * Creates `path` at mode 0700 if it doesn't exist yet, and leaves it (and whatever it already
 * holds) alone otherwise. No credential data crosses this directory: `setup-credentials.ts`
 * streams credentials into the `n8n` container over stdin and reads the existing-credentials
 * export back over stdout, entirely inside the container's own `/tmp`. The directory now serves
 * only `pnpm run export` (`export-workflows.ts` writes its output under `.n8n-import/export`,
 * recreating that one subdirectory itself with `mkdirSync`, which defaults to 0755); this is a
 * safety net so the directory itself exists, at the stricter local default mode, before anything
 * else touches it.
 *
 * On Linux, the bind mount only works when the host uid matches n8n's container uid (1000),
 * because n8n writes into a directory the host creates at 0700 — this function's own mode. A CI
 * runner whose uid differs would create the directory but still be unable to read back what n8n
 * writes into it; CI avoids the problem entirely by never using this bind mount for credentials.
 */
export function ensureN8nImportDir(path: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is the caller-provided .n8n-import path, not user input
  if (existsSync(path)) return;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is the caller-provided .n8n-import path, not user input
  mkdirSync(path, { mode: 0o700 });
}

function main(): void {
  if (existsSync(ENV_PATH)) {
    console.error('.env already exists; delete it to regenerate.');
    process.exitCode = 1;
    return;
  }
  const example = readFileSync(EXAMPLE_PATH, 'utf8');
  writeEnvFile(ENV_PATH, fillSecrets(example));
  ensureN8nImportDir(N8N_IMPORT_DIR);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
