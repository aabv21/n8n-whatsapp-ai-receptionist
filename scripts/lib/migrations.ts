export const MIGRATIONS_DIR = 'db/migrations';

/** `NNN_short_name.sql`: a three-digit sequence number, then a lowercase name. */
export const MIGRATION_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

/** The `.sql` files in `fileNames`, in sequence order. Throws on a misnamed file or a reused sequence number. */
export function orderMigrations(fileNames: readonly string[]): string[] {
  const files = fileNames.filter((name) => name.endsWith('.sql')).sort();
  const seen = new Map<string, string>();
  for (const file of files) {
    const sequence = MIGRATION_NAME.exec(file)?.[1];
    if (sequence === undefined) throw new Error(`${MIGRATIONS_DIR}/${file}: name it like 001_short_name.sql`);
    const other = seen.get(sequence);
    if (other !== undefined) throw new Error(`${MIGRATIONS_DIR}: ${other} and ${file} share ${sequence}; renumber one`);
    seen.set(sequence, file);
  }
  return files;
}

export function pendingMigrations(files: readonly string[], applied: ReadonlySet<string>): string[] {
  return files.filter((file) => !applied.has(file));
}
