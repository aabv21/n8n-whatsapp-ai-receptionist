import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ensureN8nImportDir, fillSecrets, writeEnvFile } from '../scripts/init-env.ts';

const example = ['# Postgres', 'POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=', 'N8N_DB_PASSWORD=', 'APP_DB_PASSWORD=',
  'APP_RUNTIME_DB_USER=app_runtime', 'APP_RUNTIME_DB_PASSWORD=', 'N8N_ENCRYPTION_KEY=', 'DEV_HARNESS_TOKEN=', 'ANTHROPIC_API_KEY=',
  'GOOGLE_OAUTH_CLIENT_SECRET=', 'WHATSAPP_ACCESS_TOKEN=', 'N8N_URL=http://localhost:5678', ''].join('\n');

describe('fillSecrets', () => {
  it('fills only the stack/dev-harness names, keeps every other blank and preset value as-is', () => {
    let n = 0;
    const next = (): string => `hex${String(++n)}`;
    expect(fillSecrets(example, next)).toBe(['# Postgres', 'POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=hex1', 'N8N_DB_PASSWORD=hex2',
      'APP_DB_PASSWORD=hex3', 'APP_RUNTIME_DB_USER=app_runtime', 'APP_RUNTIME_DB_PASSWORD=hex4', 'N8N_ENCRYPTION_KEY=hex5',
      'DEV_HARNESS_TOKEN=hex6', 'ANTHROPIC_API_KEY=', 'GOOGLE_OAUTH_CLIENT_SECRET=', 'WHATSAPP_ACCESS_TOKEN=',
      'N8N_URL=http://localhost:5678', ''].join('\n'));
  });
});

describe('writeEnvFile', () => {
  it('writes .env atomically at mode 0600, even over a stale, looser-mode temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmb-env-'));
    try {
      const path = join(dir, '.env');
      // A stale `.env.tmp` from a crashed run keeps its looser mode without writeEnvFile's chmod.
      writeFileSync(`${path}.tmp`, 'stale', { mode: 0o644 });
      writeEnvFile(path, 'A=1\nN8N_ENCRYPTION_KEY=secret\n');
      expect(readFileSync(path, 'utf8')).toBe('A=1\nN8N_ENCRYPTION_KEY=secret\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('ensureN8nImportDir', () => {
  it('creates the directory at mode 0700 when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmb-import-'));
    try {
      const target = join(dir, '.n8n-import');
      ensureN8nImportDir(target);
      expect(statSync(target).isDirectory()).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('leaves an existing directory and its contents alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmb-import-'));
    try {
      const target = join(dir, '.n8n-import');
      mkdirSync(target, { mode: 0o755 });
      writeFileSync(join(target, 'kept.json'), '{}');
      ensureN8nImportDir(target);
      expect(readFileSync(join(target, 'kept.json'), 'utf8')).toBe('{}');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('.gitignore', () => {
  it("ignores the temp file writeEnvFile renames over .env, so a crashed run's secrets can't be committed", async () => {
    // `git check-ignore -q` exits 0 when the path is ignored, and 1 (rejecting here) when it isn't.
    await expect(promisify(execFile)('git', ['check-ignore', '-q', '.env.tmp'])).resolves.toBeDefined();
  });
});
