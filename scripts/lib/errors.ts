/** True for a filesystem error whose code is `ENOENT`: the file or directory doesn't exist. */
export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

/** True for a failed child process from `execFileWithInput`, which carries the command's stdout and stderr. */
export function isExecError(err: unknown): err is { stdout: string; stderr: string } {
  if (typeof err !== 'object' || err === null) return false;
  const { stdout, stderr } = err as { stdout?: unknown; stderr?: unknown };
  return typeof stdout === 'string' && typeof stderr === 'string';
}
