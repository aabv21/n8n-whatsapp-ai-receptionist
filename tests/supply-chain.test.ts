import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/** One Compose service's block: the lines from `  <name>:` up to the next service at the same indent. */
const serviceBlock = (text: string, name: string): string =>
  text.split(/^ {2}(?=[a-z][\w-]*:$)/m).find((block) => block.startsWith(`${name}:`)) ?? '';

test('every long-running Compose service blocks privilege escalation, and n8n drops every capability', () => {
  const compose = readFileSync('compose.yaml', 'utf8');
  const queue = readFileSync('compose.queue.yaml', 'utf8');
  const services: [string, string][] = [[compose, 'postgres'], [compose, 'n8n'], [compose, 'ngrok'], [queue, 'redis']];
  for (const [text, name] of services) expect(serviceBlock(text, name), name).toMatch(/^ {4}security_opt:\n {6}- no-new-privileges:true$/m);
  // n8n runs as the unprivileged node user and needs no capability. Postgres's and Redis's entrypoints
  // change file owners and switch users as root, so they keep Docker's default set, and so does ngrok.
  expect(serviceBlock(compose, 'n8n')).toMatch(/^ {4}cap_drop:\n {6}- ALL$/m);
  for (const [text, name] of services.filter(([, n]) => n !== 'n8n')) expect(serviceBlock(text, name), name).not.toContain('cap_drop');
  // n8n-worker extends compose.yaml's own n8n service, so it inherits both settings instead of restating them.
  expect(serviceBlock(queue, 'n8n-worker')).toMatch(/^ {4}extends:\n {6}file: compose\.yaml\n {6}service: n8n$/m);
});

test('every image a CI workflow runs with docker run is pinned by digest', () => {
  const images: string[] = [];
  for (const file of readdirSync('.github/workflows').filter((f) => f.endsWith('.yml'))) {
    for (const line of readFileSync(`.github/workflows/${file}`, 'utf8').split('\n').filter((l) => /\bdocker run\b/.test(l))) {
      images.push(/\s([a-z0-9][\w./-]*:\S+)/.exec(line)?.[1] ?? `unparsed: ${line.trim()}`);
    }
  }
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) expect(image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[a-f0-9]{64}$/);
});

test('CI installs zizmor only from a requirements file that pins it by hash', () => {
  const pipLines = readFileSync('.github/workflows/ci.yml', 'utf8').split('\n').filter((l) => /\bpip install\b/.test(l));
  expect(pipLines.length).toBeGreaterThan(0);
  for (const line of pipLines) expect(line.trim()).toBe('pip install --require-hashes -r .github/zizmor-requirements.txt');
  const requirements = readFileSync('.github/zizmor-requirements.txt', 'utf8');
  expect(requirements).toMatch(/^zizmor==1\.31\.1 \\$/m);
  expect([...requirements.matchAll(/--hash=sha256:[a-f0-9]{64}/g)].length).toBeGreaterThan(0);
});
