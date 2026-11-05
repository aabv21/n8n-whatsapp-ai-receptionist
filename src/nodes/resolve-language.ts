import { detectLanguage } from './shared/detect-language.ts';
import { localeSetting, type Lang } from './shared/locale.ts';

export interface LanguageInput {
  text: string;
  /** `text`, or `other` for a non-text or blank message (Normalize text's own type). */
  type: string;
  /** `config.locale`, expected as `{ default: "en" | "es" }`. */
  locale: unknown;
}

export interface Language {
  lang: Lang;
  lang_detected: boolean;
}

/**
 * `config.locale.default`, or English, the source language, when it isn't set (a config written
 * before it existed) or names no supported language.
 */
function defaultLang(locale: unknown): Lang {
  if (typeof locale !== 'object' || locale === null || Array.isArray(locale)) return 'en';
  return localeSetting((locale as { default?: unknown }).default, 'en') ?? 'en';
}

/**
 * The language this message's fixed replies and prompt hint use: the one its text shows, or
 * `config.locale.default` when it shows none (a non-text message, "ok", an emoji). An unsupported
 * default falls back to English instead of stopping the run, so a config mistake never costs a
 * patient their reply.
 */
export function run(input: LanguageInput): Language {
  const fallback = defaultLang(input.locale);
  const detected = input.type === 'text' ? detectLanguage(input.text) : null;
  return detected === null ? { lang: fallback, lang_detected: false } : { lang: detected, lang_detected: true };
}
