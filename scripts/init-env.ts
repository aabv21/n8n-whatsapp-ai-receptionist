import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EXAMPLE_PATH = '.env.example';
const ENV_PATH = '.env';
const N8N_IMPORT_DIR = '.n8n-import';

// The blank `.env.example` names the local stack and the credential-free `retention` dev-harness
// target need a real value for. Third-party values (Google, WhatsApp, Anthropic, TypeSafe, ngrok)
// stay blank: generating them would make a workflow that needs a real credential look configured.
const GENERATED_NAMES = new Set([
  'POSTGRES_PASSWORD',
  'N8N_DB_PASSWORD',
  'APP_DB_PASSWORD',
  'APP_RUNTIME_DB_PASSWORD',
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
 * Writes `.env` atomically at mode 0600, through a tmp file and a rename: a truncated `.env` would
 * lose `N8N_ENCRYPTION_KEY` and with it every stored n8n credential. The explicit chmod covers a
 * stale tmp file from a crashed run, since `writeFileSync`'s `{ mode }` only applies to a new file.
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
 * Creates the `.n8n-import/` bind-mount directory at mode 0700 if it's missing, before anything
 * else touches it. Only `pnpm run export` uses it; credentials never cross it (see
 * `setup-credentials.ts`). On Linux it works only when the host uid matches n8n's container uid
 * (1000), because of that 0700 mode.
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
