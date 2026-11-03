import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

// Plan, task, ruling, and review references mean nothing to a reader of this repo: each comment,
// test, doc, and sticky note states its own reason instead.
const REFERENCE = /Ruling P\d|Task \d|\btask-\d{2}\b|\bthe brief\b|global constraints|owner session|integration pass/i;
// A review finding's ID (`I1`, `M5`, `C1`) standing alone in prose. Case-sensitive, so a lowercase
// token such as an SVG path's `m6` never matches; the generated diagram files are skipped below.
const FINDING_ID = /\b[FIMCU]\d{1,2}\b/;

/** Lockfiles and the files archify generates from `docs/diagrams/*.json`, whose SVG paths and CSS are full of `M6`-like tokens. */
const isGenerated = (file: string): boolean => file === 'pnpm-lock.yaml' || /^docs\/diagrams\/[^/]+\.(?:html|svg)$/.test(file);

test('the patterns catch process wording and finding IDs, and leave ordinary text alone', () => {
  for (const text of ['see Task 3', 'from task-08', 'per the brief', 'the global constraints', 'in the owner session', 'Owner session', 'during the integration pass']) {
    expect(REFERENCE.test(text), text).toBe(true);
  }
  for (const text of ['fixes I1', 'as M5 says', '(C1)', 'U2 and F10']) expect(FINDING_ID.test(text), text).toBe(true);
  for (const text of ['a brief window', 'the task runner', 'IPv4', 'ID1', 'C100', 'm6 path', 'utf-8', 'H2 heading']) {
    expect(REFERENCE.test(text) || FINDING_ID.test(text), text).toBe(false);
  }
});

test('no tracked file points at a plan task, a brief, a ruling, or a review finding instead of stating its reason', async () => {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard']);
  const offenders: string[] = [];
  for (const file of stdout.split('\n').filter(Boolean)) {
    if (isGenerated(file) || file === 'tests/hygiene.test.ts') continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue; // a file deleted in the working tree but still in the index
    }
    if (content.includes('\0')) continue; // a binary file
    content.split('\n').forEach((line, index) => {
      if (REFERENCE.test(line) || FINDING_ID.test(line)) offenders.push(`${file}:${String(index + 1)}`);
    });
  }
  expect(offenders).toEqual([]);
});
