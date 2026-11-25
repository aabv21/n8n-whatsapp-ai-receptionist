/** The names in `names` that `env` leaves unset or empty. Compose turns an unset name into an empty one, so both count. */
export function missingEnv(names: readonly string[], env: Readonly<Record<string, string | undefined>>): string[] {
  // eslint-disable-next-line security/detect-object-injection -- name comes from a migration's own \getenv line, not user input
  return names.filter((name) => !env[name]);
}

/** The error for `source` needing `missing`. It names variables only, never a value. */
export function missingEnvError(source: string, missing: readonly string[]): Error {
  const verb = missing.length === 1 ? 'is' : 'are';
  return new Error(`${source} needs ${missing.join(', ')}, which ${verb} not set in .env; see .env.example and docs/database.md`);
}
