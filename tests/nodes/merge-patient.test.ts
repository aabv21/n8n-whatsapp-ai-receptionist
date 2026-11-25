import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import { PATIENT_STATUSES, run, type MergePatientInput } from '../../src/nodes/merge-patient.ts';
import { runGenerated } from '../helpers/run-generated.ts';

const stored = { name: 'Laura Gomez', service_of_interest: 'Dental cleaning', last_appointment: '2026-11-04T09:30:00.000-05:00', status: 'booked' };
const today = '2026-11-04';

const merged = (update: Record<string, unknown>, from: MergePatientInput['stored'] = stored): ReturnType<typeof run> =>
  run({ update: { phone: '570000000001', status: 'inquiry', ...update }, stored: from, today });

// Google Sheets' Append or Update writes whatever is mapped, so a blank value from the model would
// erase the stored one. Nothing needs to clear a field, so blank means "not given".
test('a blank or whitespace-only name, service, or last appointment keeps the stored value', () => {
  expect(merged({ name: '  ', service_of_interest: '' })).toMatchObject({
    name: 'Laura Gomez',
    service_of_interest: 'Dental cleaning',
    last_appointment: '2026-11-04T09:30:00.000-05:00',
    status: 'booked',
  });
  expect(merged({ last_appointment: ' ' })).toMatchObject({ last_appointment: stored.last_appointment });
});

test('a non-blank update overwrites the stored value', () => {
  expect(merged({ status: 'booked', name: ' Laura G. ', service_of_interest: 'Teeth whitening', last_appointment: '2026-11-06T08:00:00.000-05:00' }))
    .toMatchObject({ name: 'Laura G.', service_of_interest: 'Teeth whitening', last_appointment: '2026-11-06T08:00:00.000-05:00', status: 'booked' });
});

test("a first-time patient's empty placeholder gives empty fields, never undefined", () => {
  expect(merged({}, {})).toEqual({ last_contact: today, phone: '570000000001', status: 'inquiry', name: '', service_of_interest: '', last_appointment: '' });
});

test('an inquiry never downgrades a stored status, but a booked or handed_off update replaces it', () => {
  expect(merged({ status: 'inquiry' }, { ...stored, status: 'handed_off' }).status).toBe('handed_off');
  expect(merged({ status: 'inquiry' }, { ...stored, status: '' }).status).toBe('inquiry');
  expect(merged({ status: 'handed_off' }).status).toBe('handed_off');
  expect(merged({ status: 'booked' }, { ...stored, status: 'handed_off' }).status).toBe('booked');
});

test('last_contact is the day the input gives', () => {
  expect(run({ update: { phone: '1', status: 'inquiry' }, stored: {}, today: '2026-11-05' }).last_contact).toBe('2026-11-05');
});

test('the generated Merge patient fields node merges the same way in the frozen sandbox', () => {
  const jsCode = `Object.defineProperty = () => ({});\n${String(readWorkflow('workflows/upsert-patient.json').nodes.find((n) => n.name === 'Merge patient fields')?.parameters.jsCode)}`;
  const input: MergePatientInput = { update: { phone: '570000000001', status: 'inquiry', name: ' ' }, stored, today };
  expect(runGenerated(jsCode, input)).toEqual([{ json: run(input) }]);
});

test("Validate input's status list is PATIENT_STATUSES", () => {
  const condition = JSON.stringify(readWorkflow('workflows/upsert-patient.json').nodes.find((n) => n.name === 'Validate input')?.parameters);
  const list = /\[('[^\]]+)\]\.includes\(/.exec(condition)?.[1] ?? '';
  expect([...list.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...PATIENT_STATUSES]);
});
