import { expect, test } from 'vitest';
import { run } from '../../src/nodes/count-cleanup-outcomes.ts';

test('all succeeded returns the count', () =>
  expect(run({ outcomes: [{ ok: true }, { ok: true }, { ok: true }] })).toEqual({ count: 3 }));
test('any failure returns null, even with other successes', () =>
  expect(run({ outcomes: [{ ok: true }, { ok: false }, { ok: true }] })).toEqual({ count: null }));
test('a single failure returns null', () => expect(run({ outcomes: [{ ok: false }] })).toEqual({ count: null }));
test('nothing matched returns a count of 0, not null', () => expect(run({ outcomes: [] })).toEqual({ count: 0 }));
