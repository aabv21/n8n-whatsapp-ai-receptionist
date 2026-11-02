import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { packageManager?: string };

// Reads pnpm's effective config, not just pnpm-workspace.yaml's text, so a misspelled key or a
// value pnpm ignores fails this test instead of passing silently.
const pnpmConfig = async (): Promise<Record<string, unknown>> => {
  const { stdout } = await execFileAsync('pnpm', ['config', 'list', '--json']);
  return JSON.parse(stdout) as Record<string, unknown>;
};

test('pnpm effective config carries every supply-chain setting', async () => {
  const config = await pnpmConfig();
  expect(config.minimumReleaseAge).toBeGreaterThanOrEqual(4320);
  // pnpm 11 ships a built-in exclusion for n8n/n8n-*/@n8n/*; this repo overrides it with an
  // explicit empty list, so nothing is exempt from the release-age gate.
  expect(config.minimumReleaseAgeExclude).toEqual([]);
  expect(config.trustPolicy).toBe('no-downgrade');
  expect(config.blockExoticSubdeps).toBe(true);
  expect(config.strictDepBuilds).toBe(true);
  expect(config.engineStrict).toBe(true);
  expect(config.dangerouslyAllowAllBuilds).toBe(false);
});

test('packageManager pins an exact pnpm 11.x version', () => {
  expect(pkg.packageManager).toMatch(/^pnpm@11\.\d+\.\d+$/);
});

test('package-lock.json does not exist', () => {
  expect(existsSync('package-lock.json')).toBe(false);
});

test('no tracked file still teaches npm commands', async () => {
  const { stdout } = await execFileAsync('git', ['ls-files']);
  const files = stdout.split('\n').filter(Boolean);
  const pattern = /\bnpm (ci|run|test|install|audit)\b|command npm/;
  const offenders: string[] = [];
  for (const file of files) {
    if (file === 'tests/supply-chain.test.ts') continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue; // binary or unreadable file; not a text hit
    }
    if (pattern.test(content)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test('every Compose image is pinned by digest', () => {
  for (const file of ['compose.yaml', 'compose.queue.yaml']) {
    const content = readFileSync(file, 'utf8');
    const images = [...content.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
  }
});
