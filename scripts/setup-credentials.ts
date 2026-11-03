import { fileURLToPath } from 'node:url';
import { compose, loadDotEnv } from './lib/runtime.ts';
import { CREDENTIALS } from './manifest.ts';

export interface ImportableCredential {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
}

// These OAuth2 types carry an interactive Google sign-in that import:credentials (which
// overwrites by id) would otherwise wipe out on every setup run.
const PROTECTED_TYPES = new Set(['googleCalendarOAuth2Api', 'googleSheetsOAuth2Api', 'gmailOAuth2']);

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

/** Which credentials to actually import: an existing Google OAuth2 credential is kept unless `force` is set. */
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

function isExecError(err: unknown): err is { stdout: string; stderr: string } {
  return typeof err === 'object' && err !== null && typeof (err as { stdout?: unknown }).stdout === 'string';
}

/**
 * The detection export used to write `.n8n-import/existing-credentials.json` and have the host
 * read and `chmod`/delete it. That fails on a Linux runner: n8n (uid 1000 in the container)
 * creates the file, so the runner (uid 1001) doesn't own it and can't `chmod` it (EPERM), even
 * once the directory itself is writable by both. Streaming the (still encrypted) export back over
 * stdout instead means the file never leaves the container: `sh -c` makes its own temp file in
 * the container's own `/tmp`, exports into it, and `cat`s it to stdout only on success, so a
 * truncated or partial export can't be mistaken for a real one — n8n's own progress messages
 * ("Acquiring database migration lock...") go to stderr here, keeping stdout pure JSON.
 */
export const EXPORT_SCRIPT = 'umask 077; tmp="$(mktemp)"; n8n export:credentials --all --output="$tmp" >&2; status=$?; [ "$status" -eq 0 ] && cat "$tmp"; rm -f "$tmp"; exit $status';

/**
 * IDs already in n8n, read from an (encrypted) CLI export over stdout — never the decrypted
 * credential data, and never a file on the bind mount (see `EXPORT_SCRIPT`'s own comment).
 */
export async function existingCredentialIds(): Promise<Set<string>> {
  let stdout: string;
  try {
    ({ stdout } = await compose(['exec', '-T', 'n8n', 'sh', '-c', EXPORT_SCRIPT]));
  } catch (err) {
    // A brand-new instance with no credentials yet errors instead of exporting an empty list.
    // n8n prints that message to stderr now (EXPORT_SCRIPT redirects its own stdout there), but a
    // non-zero exit from the script itself can still surface it on either stream.
    if (isExecError(err) && (/No credentials found/i.test(err.stderr) || /No credentials found/i.test(err.stdout))) return new Set();
    throw err;
  }

  let raw: { id: string }[];
  try {
    raw = JSON.parse(stdout) as { id: string }[];
  } catch {
    throw new Error('could not parse the credential listing from n8n export:credentials');
  }
  return new Set(raw.map((c) => c.id));
}

async function main(): Promise<void> {
  loadDotEnv();
  const force = process.argv.includes('--force');

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
