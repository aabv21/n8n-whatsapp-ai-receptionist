import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { Business } from '../src/nodes/types.ts';

const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
const kb = readFileSync('business/knowledge-base.md', 'utf8');
const prompt = readFileSync('prompts/system-prompt.md', 'utf8');

test('services and prices match the brief', () => expect(business.services).toEqual([
  { name: 'Initial evaluation', price_cop: 50000 },
  { name: 'Dental cleaning', price_cop: 120000 },
  { name: 'Teeth whitening', price_cop: 450000 },
  { name: 'Composite filling (per tooth)', price_cop: 150000 },
  { name: 'Orthodontic evaluation', price_cop: 80000 },
  { name: 'Dental emergency', price_cop: 100000 },
]));
test('hours and scheduling match the brief', () => {
  for (const d of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) expect(business.hours[d]).toEqual(['08:00', '18:00']);
  expect(business.hours.sat).toEqual(['08:00', '13:00']);
  expect(business.hours.sun).toBeNull();
  expect([business.appointment_minutes, business.max_slots_offered, business.min_notice_minutes]).toEqual([45, 3, 60]);
  expect(business.timezone).toBe('America/Bogota');
});
test('payment methods include Nequi', () =>
  expect(business.payment_methods).toEqual(['Cash', 'Card', 'Bank transfer', 'Nequi']));
test('business identity is pinned', () => {
  expect(business.name).toBe('Cumbident');
  expect(business.address).toBe('Calle 84 # 45-20, Office 302, Barranquilla, Colombia');
});
test('knowledge base covers the brief FAQs', () => {
  for (const re of [/parking/i, /free/i, /age 4/i, /insurance/i, /reimburs/i, /24 hours/i]) expect(kb).toMatch(re);
});
test('knowledge base leaves structured facts to business.json', () => {
  for (const re of [/Calle 84/, /\d{1,3}[.,]\d{3}/, /\bCOP\b/, /\b\d{1,2}:\d{2}\b/, /^#+ *Payments/im]) expect(kb).not.toMatch(re);
});
test('system prompt has each placeholder once, volatile ones last', () => {
  for (const p of ['<<BUSINESS>>', '<<KNOWLEDGE_BASE>>', '<<NOW>>', '<<TRIAGE_NOTES>>']) expect(prompt.split(p)).toHaveLength(2);
  expect(prompt.indexOf('<<NOW>>')).toBeGreaterThan(prompt.indexOf('<<KNOWLEDGE_BASE>>'));
  expect(prompt.indexOf('<<TRIAGE_NOTES>>')).toBeGreaterThan(prompt.indexOf('<<KNOWLEDGE_BASE>>'));
});
test('system prompt reads values from BUSINESS and guards other patients', () => {
  expect(prompt).not.toMatch(/up to \d|\d{1,3}[.,]\d{3}/);
  expect(prompt).toMatch(/other patients/i);
});
