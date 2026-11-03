import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { run, type LanguageInput } from '../../src/nodes/resolve-language.ts';

const config = JSON.parse(readFileSync('config/config.example.json', 'utf8')) as { locale: unknown };
const base: LanguageInput = { text: '', type: 'text', locale: config.locale };
const resolve = (input: Partial<LanguageInput>): ReturnType<typeof run> => run({ ...base, ...input });

test('a message that shows its language gets that language', () => {
  expect(resolve({ text: 'Hola, ¿cuánto cuesta una limpieza?' })).toEqual({ lang: 'es', lang_detected: true });
  expect(resolve({ text: 'How much is a dental cleaning?' })).toEqual({ lang: 'en', lang_detected: true });
});

test("a message that doesn't show its language gets the configured default, which the example sets to Spanish", () => {
  for (const text of ['ok', '👍', 'Laura Gomez']) expect(resolve({ text }), text).toEqual({ lang: 'es', lang_detected: false });
  expect(resolve({ text: 'ok', locale: { default: 'en-US' } })).toEqual({ lang: 'en', lang_detected: false });
});

test('a non-text message gets the default, whatever text came with it', () =>
  expect(resolve({ type: 'other', text: 'How much is a dental cleaning?' })).toEqual({ lang: 'es', lang_detected: false }));

test('a config written before the locale settings existed falls back to English', () => {
  const older = { text: 'ok', type: 'text' } as LanguageInput;
  expect(run(older)).toEqual({ lang: 'en', lang_detected: false });
  expect(resolve({ text: 'ok', locale: {} })).toEqual({ lang: 'en', lang_detected: false });
});

test('a default that names no supported language falls back to English, so a bad setting never costs a patient a reply', () => {
  for (const locale of [{ default: 'fr' }, { default: '' }, 'es', ['es']]) {
    expect(resolve({ text: 'ok', locale }), JSON.stringify(locale)).toEqual({ lang: 'en', lang_detected: false });
  }
  expect(resolve({ text: 'Hola, ¿tienen citas?', locale: { default: 'fr' } })).toEqual({ lang: 'es', lang_detected: true });
});

test('the team language is not this node\'s concern: an invalid team_locale changes nothing here', () => {
  const withTeam = { ...base, text: 'ok', team_locale: 'pt-BR' } as LanguageInput;
  expect(run(withTeam)).toEqual({ lang: 'es', lang_detected: false });
});
