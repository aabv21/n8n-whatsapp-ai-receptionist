import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { Business } from '../src/nodes/types.ts';

const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
const kb = readFileSync('business/knowledge-base.md', 'utf8');
const prompt = readFileSync('prompts/system-prompt.md', 'utf8');
/** The body of the prompt's `## <heading>` section, up to the next heading. */
const section = (heading: string): string => prompt.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '';

test('services and prices are pinned', () => expect(business.services).toEqual([
  { name: 'Initial evaluation', price_cop: 50000 },
  { name: 'Dental cleaning', price_cop: 120000 },
  { name: 'Teeth whitening', price_cop: 450000 },
  { name: 'Composite filling (per tooth)', price_cop: 150000 },
  { name: 'Orthodontic evaluation', price_cop: 80000 },
  { name: 'Dental emergency', price_cop: 100000 },
]));
test('opening hours and scheduling rules are pinned', () => {
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
test('knowledge base covers the FAQ topics: parking, children, insurance, and cancellations', () => {
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
test('the retry reply claims no team alert', () => {
  expect(business.replies.technical_issue_retry).toBe("Sorry, I'm having a technical issue right now. Please try again in a few minutes.");
  expect(business.replies.technical_issue_retry).not.toMatch(/team|notif|alert/i);
});
test('the reply-check replies are pinned, offer an evaluation, and quote no number', () => {
  expect(business.replies.medical_advice).toBe(
    "I can't give medical advice or recommend medicines or doses. The right next step is an initial evaluation with our dentist. Would you like me to find you a time?");
  expect(business.replies.price_check).toBe(
    "I can only quote the prices on Cumbident's price list, and I can't confirm discounts or other amounts. Tell me which service you're interested in and I'll give you its listed price.");
  expect(business.replies.medical_advice).toMatch(/evaluation/i);
  for (const reply of [business.replies.medical_advice, business.replies.price_check]) expect(reply).not.toMatch(/\d/);
});
test('the prompt tells the agent what to do with every booking limit the tools enforce', () => {
  const errors = section('Tool errors');
  for (const reason of ['off_grid', 'too_far', 'too_many_bookings']) expect(errors).toContain(reason);
});
test('a cancellation or reschedule request goes to the team, and the assistant never claims it is done', () => {
  const rule = section('Cancellations and changes');
  expect(rule).toMatch(/cancel/i);
  expect(rule).toMatch(/reschedule/i);
  expect(rule).toContain('call notify_team with reason other');
  expect(rule).toMatch(/never say the appointment is cancel/i);
});
test('a suppressed alert is never presented as a forwarded request', () => {
  const errors = section('Tool errors');
  expect(errors).toContain('suppressed: true');
  expect(errors).toMatch(/team already has (their|the patient's) earlier request/i);
  expect(errors).toMatch(/never say this new request was forwarded/i);
});
