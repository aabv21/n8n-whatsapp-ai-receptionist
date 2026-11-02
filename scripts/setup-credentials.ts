import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compose, loadDotEnv } from './lib/runtime.ts';
import { CREDENTIALS } from './manifest.ts';

export interface ImportableCredential {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
}

// Ruling P3: these OAuth2 types carry an interactive Google sign-in that import:credentials
// (which overwrites by id) would otherwise wipe out on every setup run.
const PROTECTED_TYPES = new Set(['googleCalendarOAuth2Api', 'googleSheetsOAuth2Api', 'gmailOAuth2']);

const IMPORT_DIR = '.n8n-import';
const EXISTING_FILE_NAME = 'existing-credentials.json';
const EXISTING_FILE = `${IMPORT_DIR}/${EXISTING_FILE_NAME}`;

/**
 * The import:credentials call used to write a decrypted `.n8n-import/credentials.json` on the
 * host (mode 0600) and point the CLI at it inside the container. That works on macOS, where
 * Docker Desktop's VM makes a bind-mounted file appear owned by whatever uid the reading
 * process runs as — but on a Linux runner the file is written by the runner's own uid (1001)
 * and stays owned by it inside the container too, where n8n runs as uid 1000 and can't read it.
 * Streaming the JSON over stdin instead means the plaintext credential data never touches the
 * host filesystem or the bind mount at all, so no uid can be wrong: `sh -c` inside the container
 * sets a strict umask, makes its own temp file in the container's own `/tmp` (entirely separate
 * from `.n8n-import/`), copies stdin into it, runs the import, and removes it either way.
 */
export const IMPORT_SCRIPT = 'umask 077; tmp="$(mktemp)"; cat > "$tmp"; n8n import:credentials --input="$tmp"; status=$?; rm -f "$tmp"; exit $status';

/** The exact `compose()` call that imports `toImport`: the credential JSON travels only as `input`, never as an argument or a file. */
export function buildImportCall(toImport: readonly ImportableCredential[]): { args: string[]; input: string } {
  return { args: ['exec', '-T', 'n8n', 'sh', '-c', IMPORT_SCRIPT], input: JSON.stringify(toImport) };
}

export function buildCredentials(env: Readonly<Record<string, string | undefined>>): {
  credentials: ImportableCredential[];
  skipped: { id: string; missing: string[] }[];
} {
  const credentials: ImportableCredential[] = [];
  const skipped: { id: string; missing: string[] }[] = [];

  for (const entry of CREDENTIALS) {
    const scoped: Record<string, string> = {};
    const missing: string[] = [];
    for (const key of entry.env) {
      // eslint-disable-next-line security/detect-object-injection -- key comes from this entry's own fixed `env` list, not user input
      const value = env[key];
      // eslint-disable-next-line security/detect-object-injection -- key comes from this entry's own fixed `env` list, not user input
      if (value) scoped[key] = value;
      else missing.push(key);
    }
    if (missing.length > 0) {
      skipped.push({ id: entry.id, missing });
      continue;
    }
    credentials.push({ id: entry.id, name: entry.name, type: entry.type, data: entry.data(scoped) });
  }

  return { credentials, skipped };
}

/** The skip decision for ruling P3: which credentials to actually import. */
export function skipExisting(
  credentials: readonly ImportableCredential[],
  existingIds: ReadonlySet<string>,
  force: boolean,
): { toImport: ImportableCredential[]; alreadyExists: { id: string; name: string }[] } {
  if (force) return { toImport: [...credentials], alreadyExists: [] };

  const toImport: ImportableCredential[] = [];
  const alreadyExists: { id: string; name: string }[] = [];
  for (const credential of credentials) {
    if (PROTECTED_TYPES.has(credential.type) && existingIds.has(credential.id)) {
      alreadyExists.push({ id: credential.id, name: credential.name });
    } else {
      toImport.push(credential);
    }
  }
  return { toImport, alreadyExists };
}

function isExecError(err: unknown): err is { stdout: string } {
  return typeof err === 'object' && err !== null && typeof (err as { stdout?: unknown }).stdout === 'string';
}

/** IDs already in n8n, read from an (encrypted) CLI export — never the decrypted credential data. */
async function existingCredentialIds(): Promise<Set<string>> {
  try {
    await compose(['exec', '-T', 'n8n', 'n8n', 'export:credentials', '--all', `--output=/import/${EXISTING_FILE_NAME}`]);
  } catch (err) {
    // A brand-new instance with no credentials yet errors instead of exporting an empty list.
    if (isExecError(err) && /No credentials found/i.test(err.stdout)) return new Set();
    throw err;
  }

  chmodSync(EXISTING_FILE, 0o600);
  try {
    const raw = JSON.parse(readFileSync(EXISTING_FILE, 'utf8')) as { id: string }[];
    return new Set(raw.map((c) => c.id));
  } finally {
    rmSync(EXISTING_FILE, { force: true });
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const force = process.argv.includes('--force');
  mkdirSync(IMPORT_DIR, { recursive: true });

  const { credentials, skipped } = buildCredentials(process.env);
  const existingIds = await existingCredentialIds();
  const { toImport, alreadyExists } = skipExisting(credentials, existingIds, force);

  if (toImport.length > 0) {
    const { args, input } = buildImportCall(toImport);
    await compose(args, input);
  }

  for (const { id, missing } of skipped) {
    const name = CREDENTIALS.find((c) => c.id === id)?.name ?? id;
    console.log(`skip ${name}: missing ${missing.join(', ')}`);
  }
  for (const { name } of alreadyExists) {
    console.log(`skip ${name}: already exists (use --force to overwrite)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
