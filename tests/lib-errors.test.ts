import { afterEach, expect, test, vi } from 'vitest';
import { errorMessage, runMain } from '../scripts/lib/errors.ts';

const exitCode = process.exitCode;
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

test("errorMessage gives an Error's message and any other value as a string", () => {
  expect(errorMessage(new Error('boom'))).toBe('boom');
  expect(errorMessage('plain')).toBe('plain');
  expect(errorMessage(42)).toBe('42');
});

test('runMain sets exitCode 1 and prints the message when main rejects', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  runMain(() => Promise.reject(new Error('failed run')));
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(spy).toHaveBeenCalledWith('failed run');
});

test('runMain leaves exitCode alone when main resolves', async () => {
  process.exitCode = undefined;
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  runMain(() => Promise.resolve());
  await new Promise((resolve) => setImmediate(resolve));
  expect(process.exitCode).toBeUndefined();
  expect(spy).not.toHaveBeenCalled();
});
