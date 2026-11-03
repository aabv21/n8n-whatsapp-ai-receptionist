import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

// Plan, task, and ruling references mean nothing to a reader of this repo: each comment, test, doc,
// and sticky note states its own reason instead.
const REFERENCE = /Ruling P\d|Task \d|\bthe brief\b|global constraints/;

test('no tracked file points at a plan task, a brief, or a ruling instead of stating its reason', async () => {
  const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard']);
  const offenders: string[] = [];
  for (const file of stdout.split('\n').filter(Boolean)) {
    if (file === 'pnpm-lock.yaml' || file === 'tests/hygiene.test.ts') continue;
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue; // a file deleted in the working tree but still in the index
    }
    content.split('\n').forEach((line, index) => {
      if (REFERENCE.test(line)) offenders.push(`${file}:${String(index + 1)}`);
    });
  }
  expect(offenders).toEqual([]);
});
