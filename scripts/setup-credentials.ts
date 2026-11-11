import { fileURLToPath } from 'node:url';
import { isExecError } from './lib/errors.ts';
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
 * Imports credentials streamed over stdin, so the decrypted JSON never touches the host or the
 * `.n8n-import/` bind mount. A host file fails on Linux: the runner's uid (1001) owns it inside the
 * container too, where n8n (uid 1000) can't read it; Docker Desktop on macOS hides that. The script
 * writes a umask-077 temp file in the container's own `/tmp` and removes it either way.
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

/**
 * Exports the (still encrypted) credentials to stdout, so the file never leaves the container: on
 * Linux, a file n8n (uid 1000) writes to the bind mount can't be `chmod`ed by the runner (uid
 * 1001, EPERM). The script `cat`s its container `/tmp` file only on success, so a partial export
 * can't pass for a real one, and sends n8n's progress messages to stderr to keep stdout pure JSON.
 */
export const EXPORT_SCRIPT = 'umask 077; tmp="$(mktemp)"; n8n export:credentials --all --output="$tmp" >&2; status=$?; [ "$status" -eq 0 ] && cat "$tmp"; rm -f "$tmp"; exit $status';

/** IDs already in n8n, from the encrypted export over stdout (see `EXPORT_SCRIPT`). */
export async function existingCredentialIds(): Promise<Set<string>> {
  let stdout: string;
  try {
    ({ stdout } = await compose(['exec', '-T', 'n8n', 'sh', '-c', EXPORT_SCRIPT]));
  } catch (err) {
    // A brand-new instance errors instead of exporting an empty list. EXPORT_SCRIPT sends n8n's
    // stdout to stderr, but check both streams in case the message lands on either.
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
