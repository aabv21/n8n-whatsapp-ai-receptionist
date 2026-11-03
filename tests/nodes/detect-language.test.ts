import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { Scenario, TriageItem } from '../../scripts/lib/scenarios.ts';
import { detectLanguage } from '../../src/nodes/shared/detect-language.ts';

const expectEach = (texts: string[], lang: 'en' | 'es' | null): void => {
  for (const text of texts) expect(detectLanguage(text), text).toBe(lang);
};

test('short greetings and answers resolve when they carry a language, and stay unknown when they do not', () => {
  expectEach(['hola', 'Hola!', 'sí', 'si', 'Sí, por favor', 'gracias', 'buenas tardes', 'ok gracias'], 'es');
  expectEach(['thanks', 'Thank you!', 'hi', 'hello', 'yes please', 'ok thanks'], 'en');
  expectEach(['ok', 'OK', 'Ok.', 'no', 'Nequi', 'Laura Gomez', '10:30', '2026-11-05'], null);
});

test('emoji, punctuation, digits, and blank text carry no language', () =>
  expectEach(['👍', '😀🦷', '???', '...', '123', '', '   '], null));

test('Spanish written without accents is still Spanish', () =>
  expectEach([
    'hola quiero una cita para manana',
    'cuanto cuesta una limpieza',
    'que horario tienen el sabado',
    'necesito una cita urgente, me duele una muela',
  ], 'es'));

test('a mixed message resolves to the language most of it is in, and an even mix stays unknown', () => {
  expectEach(['Hola, do you have appointments tomorrow?', 'Hello, I need an appointment para mañana'], 'en');
  expectEach(['Hi, quiero una cita para mañana', 'Hello! ¿Tienen citas el sábado?'], 'es');
  expectEach(['hola thanks', 'gracias, thanks', 'Hola, hi'], null);
});

test('names alone, accented or not, never decide the language', () =>
  expectEach(['José Pérez', 'Bogotá', 'Laura Gómez', 'Martínez'], null));

test('an accented word adds to Spanish words or marks, but is never enough on its own', () => {
  expectEach(['Pérez, gracias', '¿José?'], 'es');
  expectEach(['José Pérez, thanks'], 'en');
});

test('a message mostly in English with a few Spanish words stays English', () =>
  expectEach(['Necesito un appointment for tomorrow', 'Quiero book an appointment'], 'en'));

test('one accented name in an English message does not make it Spanish', () =>
  expectEach(['Hi, this is José and I need an appointment', "My name is Juan Pérez, what's the price of a cleaning?"], 'en'));

test('¿ and ¡ mark Spanish even around a word the lists do not know', () => expectEach(['¿Ok?', '¡Excelente!'], 'es'));

test('every triage fixture resolves to its own declared language', () => {
  const items = JSON.parse(readFileSync('tests/scenarios/triage.json', 'utf8')) as TriageItem[];
  for (const item of items) expect(detectLanguage(item.text), item.text).toBe(item.lang);
});

// The conversation scenarios carry no language field: the Spanish ones are exactly these ids.
const SPANISH_SCENARIOS = new Set([
  'spanish-reply', 'instruction-override', 'prompt-extraction', 'other-patient-data', 'booking-limit',
  'fake-discount', 'dose-request', 'classifier-injection', 'context-poisoning', 'cancellation',
]);

test('every conversation turn resolves to its scenario language', () => {
  const scenarios = JSON.parse(readFileSync('tests/scenarios/conversations.json', 'utf8')) as Scenario[];
  for (const id of SPANISH_SCENARIOS) expect(scenarios.some((s) => s.id === id), id).toBe(true);
  for (const scenario of scenarios) {
    const lang = SPANISH_SCENARIOS.has(scenario.id) ? 'es' : 'en';
    for (const turn of scenario.turns) expect(detectLanguage(turn.text), `${scenario.id}: ${turn.text}`).toBe(lang);
  }
});
