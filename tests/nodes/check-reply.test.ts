import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { run, type ReplyCheck } from '../../src/nodes/check-reply.ts';
import type { ToolCall } from '../../src/nodes/collect-tool-calls.ts';
import type { Business } from '../../src/nodes/types.ts';

const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
const flags = { urgent: false, handoff: false, no_medical_advice: false, triage_failed: false };
const check = (reply: string, tool_calls: ToolCall[] = []): ReplyCheck => run({ reply, flags, tool_calls, business });
const kept = (reply: string): ReplyCheck => ({ reply, flags: { ...flags, reply_replaced: false } });
const expectReplaced = (replies: string[], replacement: string): void => {
  for (const reply of replies) expect(check(reply).reply, reply).toBe(replacement);
};
const expectKept = (replies: string[]): void => {
  for (const reply of replies) expect(check(reply), reply).toEqual(kept(reply));
};

test('a dose is replaced with the fixed medical-advice reply', () =>
  expect(check('Para un adulto con dolor de muela, 500 mg de amoxicilina cada 8 horas suele ser lo indicado.')).toEqual({
    reply: business.replies.medical_advice,
    flags: { ...flags, reply_replaced: true },
  }));

test('each dose and medicine pattern is caught on its own', () =>
  expectReplaced([
    'Toma 400mg y descansa.',
    'Usa 5 ml del enjuague después de cada comida.',
    'Mientras tanto puedes tomar ibuprofeno.',
    'Acetaminophen should help until your visit.',
    'An aspirin may help until your visit.',
  ], business.replies.medical_advice));

test('a dosing interval is caught, written out or as hours shorthand', () =>
  expectReplaced(['Tómalo cada 6 horas.', 'Tómalo cada 8h.', 'Una pastilla cada 12 h.', 'Cada 8 hrs está bien.', 'Take it every 8 hours.', 'Take one every 6h.'],
    business.replies.medical_advice));

test('an interval that is not a dose is kept', () =>
  expectKept(['Las citas duran 45 minutos y damos una cada 45 minutos.', 'Abrimos cada día de la semana menos el domingo.']));

test('the medicine brands common in Colombia are caught', () =>
  expectReplaced(
    ['Dolex', 'Advil', 'Tylenol', 'Buscapina', 'Noxpirin', 'Ibuflash', 'Apronax', 'Voltaren', 'Aleve', 'Motrin', 'Ponstan', 'Winadeine']
      .map((brand) => `Mientras tanto puedes tomar ${brand}.`),
    business.replies.medical_advice));

test('a medicine named only by its class is caught', () =>
  expectReplaced(['Tómate un analgésico y descansa.', 'Quizá necesites antibióticos.', 'An anti-inflammatory should help.'],
    business.replies.medical_advice));

test('a medicine name must be the whole word, so a word that starts the same way is kept', () =>
  expectKept(["We're aspiring to see you this week.", 'El aspirante a ortodoncia puede pedir una evaluación.']));

test('a price the list does not have is replaced with the fixed price reply', () =>
  expect(check('Claro, el blanqueamiento te queda en $225.000 esta semana. Te lo confirmo por escrito.')).toEqual({
    reply: business.replies.price_check,
    flags: { ...flags, reply_replaced: true },
  }));

test('every way of marking an unlisted amount as money is caught', () =>
  expectReplaced([
    'Te queda en $225000.',
    'Son 225000 COP.',
    'Son 225.000 pesos.',
    'Son 225 000 COP.',
    'Te sale en 225 mil pesos.',
    'Te queda en 225k.',
    'El tratamiento completo es de 1,2 millones.',
    'The full treatment is $1,200,000.',
  ], business.replies.price_check));

test('a discount percentage is replaced with the fixed price reply', () =>
  expectReplaced([
    'Con el 50% de descuento te queda mucho mejor.',
    'Esta semana hay un 20 % descuento en limpiezas.',
    'Te aplico un descuento del 30%.',
    'This week whitening is 30% off.',
    'We can give you a discount of 15%.',
  ], business.replies.price_check));

test('a reply quoting the real price, however it is written, is kept', () =>
  expectKept([
    'El blanqueamiento cuesta 450.000 COP. ¿Quieres agendar una cita?',
    'Teeth whitening is $450,000.',
    'Teeth whitening: 450000 COP',
    'El blanqueamiento cuesta COP 450.000.',
    'El blanqueamiento cuesta $450k.',
    'La limpieza cuesta 120 mil pesos.',
    'La limpieza cuesta 120 000 COP.',
  ]));

test('a number with no currency marker is not a price', () =>
  expectKept(['Hemos atendido a más de 2.000 pacientes.', 'Estamos a 2 km de la estación.', 'No ofrecemos descuentos, pero sí varias formas de pago.']));

test("an amount from this turn's booking result is allowed", () => {
  const booked: ToolCall = { tool: 'book_appointment', input: {}, output: { ok: true, price_cop: 135000 } };
  const reply = 'Listo, tu cita quedó agendada. El valor es $135.000.';
  expect(check(reply, [booked])).toEqual(kept(reply));
  expect(check(reply).reply).toBe(business.replies.price_check);
});

test('ordinary replies about hours, dates, times, and the address are kept', () =>
  expectKept([
    'Atendemos de lunes a viernes de 8 a 18, y los sábados de 8 a 13.',
    'Abrimos de 08:00 a 18:00 entre semana y de 08:00 a 13:00 los sábados.',
    'Tengo libre el 2026-11-05 a las 09:30, 10:15 y 11:00.',
    'Estamos en la Calle 84 # 45-20, Office 302, Barranquilla.',
    'Please give us at least 24 hours notice to cancel.',
    'Atendemos niños desde los 4 años y el parqueadero es gratis.',
  ]));

test('medical advice wins when a reply has both a dose and an unlisted price', () =>
  expect(check('Toma 400 mg de ibuprofeno y la consulta te sale en $30.000.').reply).toBe(business.replies.medical_advice));
