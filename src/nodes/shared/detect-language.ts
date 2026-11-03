import type { Lang } from './locale.ts';

// Common words that mark one language and almost never appear in the other. A word both use the
// same way ("no", "me", "a", "ok", "dental", "hospital") is in neither list, so it never counts.
const SPANISH_WORDS = new Set([
  'hola', 'buenas', 'buenos', 'dias', 'días', 'tardes', 'noches', 'gracias', 'favor', 'si', 'sí', 'claro', 'listo', 'vale',
  'bueno', 'perfecto', 'chao', 'adios', 'adiós', 'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'al', 'en', 'y', 'o',
  'que', 'qué', 'con', 'para', 'por', 'pero', 'porque', 'pues', 'como', 'cómo', 'cual', 'cuál', 'cuanto', 'cuánto',
  'cuantos', 'cuántos', 'donde', 'dónde', 'cuando', 'cuándo', 'es', 'esta', 'está', 'este', 'esto', 'eso', 'estoy', 'soy',
  'eres', 'hay', 'tiene', 'tienen', 'tengo', 'quiero', 'quisiera', 'necesito', 'puedo', 'puede', 'pueden', 'hacer',
  'hablar', 'dime', 'llamo', 'mi', 'mis', 'tu', 'tus', 'su', 'lo', 'le', 'se', 'te', 'muy', 'mas', 'más', 'tambien',
  'también', 'ya', 'ahora', 'aqui', 'aquí', 'nada', 'todo', 'todas', 'todos', 'otra', 'otro', 'sobre', 'usted', 'ustedes',
  'nombre', 'cita', 'citas', 'precio', 'precios', 'cuesta', 'valor', 'horario', 'horarios', 'hora', 'horas', 'hoy',
  'mañana', 'manana', 'semana', 'lunes', 'martes', 'miercoles', 'miércoles', 'jueves', 'viernes', 'sabado', 'sábado',
  'domingo', 'dolor', 'duele', 'muela', 'muelas', 'diente', 'dientes', 'limpieza', 'blanqueamiento', 'ortodoncia',
  'urgencia', 'consulta', 'persona', 'atienden', 'abren', 'parqueadero', 'niños', 'ninos',
]);

const ENGLISH_WORDS = new Set([
  'hi', 'hello', 'hey', 'thanks', 'thank', 'please', 'yes', 'yeah', 'sure', 'bye', 'goodbye', 'the', 'an', 'and', 'or',
  'to', 'for', 'of', 'with', 'in', 'on', 'at', 'from', 'about', 'if', 'is', 'are', 'am', 'was', 'be', 'will', 'can',
  'could', 'would', 'do', 'does', 'did', 'have', 'has', 'get', 'got', 'want', 'like', 'need', 'help', 'talk', 'i',
  "i'm", 'im', "i'd", "i'll", 'my', 'you', 'your', 'we', 'our', 'it', "it's", 'this', 'that', 'there', 'their', 'not',
  "don't", 'dont', "can't", 'cant', 'just', 'also', 'any', 'what', 'when', 'where', 'which', 'who', 'how', 'much',
  'good', 'great', 'next', 'time', 'name', 'person', 'someone', 'appointment', 'appointments', 'book', 'booking',
  'price', 'prices', 'cost', 'costs', 'cleaning', 'whitening', 'filling', 'tooth', 'teeth', 'pain', 'hurts', 'swollen',
  'emergency', 'hours', 'open', 'today', 'tomorrow', 'week', 'morning', 'afternoon', 'evening', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

const WORD_RE = /[\p{L}']+/gu;
const SPANISH_LETTER_RE = /[áéíóúüñ]/;
/** `¿` and `¡` open a question or exclamation only in Spanish, so each one counts this much. */
const OPENING_MARK_WEIGHT = 2;
/** The share of all signals the leading language needs before a guess is made. */
const MIN_SHARE = 0.6;

/**
 * The language a patient message is written in, from its words alone: a deterministic count of
 * Spanish signals (`¿`, `¡`, common Spanish words, and accented words or `ñ`) against common
 * English words. An accented word the list doesn't know, such as a name like "Pérez" or "Bogotá",
 * only adds to Spanish that a listed word or an opening mark already shows; it never decides on
 * its own. Returns null when neither side clearly leads, such as for "ok", an emoji, a name, or an
 * even mix, so the caller falls back to its configured default instead of guessing.
 */
export function detectLanguage(text: string): Lang | null {
  const normalized = text.normalize('NFC').toLowerCase().replaceAll('’', "'");
  let spanish = 0;
  let accentedOnly = 0;
  let english = 0;
  if (normalized.includes('¿')) spanish += OPENING_MARK_WEIGHT;
  if (normalized.includes('¡')) spanish += OPENING_MARK_WEIGHT;
  for (const match of normalized.matchAll(WORD_RE)) {
    const word = match[0].replace(/^'+|'+$/g, '').replace(/'s$/, '');
    if (ENGLISH_WORDS.has(word)) english += 1;
    else if (SPANISH_WORDS.has(word)) spanish += 1;
    else if (SPANISH_LETTER_RE.test(word)) accentedOnly += 1;
  }
  if (spanish > 0) spanish += accentedOnly;
  const total = spanish + english;
  if (total === 0) return null;
  if (spanish > english && spanish / total >= MIN_SHARE) return 'es';
  if (english > spanish && english / total >= MIN_SHARE) return 'en';
  return null;
}
