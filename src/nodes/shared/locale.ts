/** The languages every patient reply and team message is written in. English is the source language. */
export type Lang = 'en' | 'es';

export const LANGS: readonly Lang[] = ['en', 'es'];

/** A text in every supported language. */
export type Localized = Record<Lang, string>;

/**
 * The supported language a locale names (`es-CO`, `es_CO`, `ES`, `en-US`, …), or null for anything
 * else, including a language this repo has no text for.
 */
export function normalizeLocale(value: unknown): Lang | null {
  if (typeof value !== 'string') return null;
  const [primary = '', ...subtags] = value.trim().toLowerCase().split(/[-_]/);
  if (!subtags.every((subtag) => /^[a-z0-9]{1,8}$/.test(subtag))) return null;
  return primary === 'en' || primary === 'es' ? primary : null;
}

/** The entry of a per-language table for `lang`. */
export function pick<T>(table: Readonly<Record<Lang, T>>, lang: Lang): T {
  // eslint-disable-next-line security/detect-object-injection -- lang is typed as one of the two Lang literals, and every caller normalizes it first
  return table[lang];
}

/**
 * A locale setting from config: `fallback` when it isn't set at all, its normalized language when it
 * names a supported one, and null when it is set to anything else, so the caller can refuse it.
 */
export function localeSetting(value: unknown, fallback: Lang): Lang | null {
  return value === undefined || value === null ? fallback : normalizeLocale(value);
}
