import { expect, test } from 'vitest';
import { localeSetting, normalizeLocale } from '../../src/nodes/shared/locale.ts';

test('normalizes any spelling of a supported locale to its language', () => {
  for (const value of ['es', 'ES', 'es-CO', 'es_CO', 'es-419', ' es-co ']) expect(normalizeLocale(value), value).toBe('es');
  for (const value of ['en', 'EN', 'en-US', 'en_US', 'en-GB']) expect(normalizeLocale(value), value).toBe('en');
});

test('anything else is not a supported locale', () => {
  for (const value of ['fr', 'pt-BR', 'english', 'espanol', 'e', '', '-es', 'es--CO', 'es CO', null, undefined, 1, {}, ['es']]) {
    expect(normalizeLocale(value), JSON.stringify(value)).toBeNull();
  }
});

test('a missing setting takes the fallback, a supported one is normalized, and an unsupported one is invalid', () => {
  expect(localeSetting(undefined, 'en')).toBe('en');
  expect(localeSetting(null, 'es')).toBe('es');
  expect(localeSetting('es-CO', 'en')).toBe('es');
  expect(localeSetting('fr', 'en')).toBeNull();
  expect(localeSetting('', 'en')).toBeNull();
});
