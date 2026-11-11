import { DateTime } from 'luxon';
import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import { evaluateExpression } from '../helpers/run-expression.ts';

const wf = readWorkflow('workflows/upsert-patient.json');
const merge = String(wf.nodes.find((n) => n.name === 'Merge patient fields')?.parameters.jsonOutput);

const stored = { name: 'Laura Gomez', service_of_interest: 'Dental cleaning', last_appointment: '2026-11-04T09:30:00.000-05:00', status: 'booked' };

const merged = (update: Record<string, unknown>, json: unknown = stored, timezone = 'America/Bogota', now = DateTime.fromISO('2026-11-05T03:00:00Z')): Record<string, unknown> =>
  evaluateExpression(merge, {
    nodes: { 'Receive patient update': update, 'Load context': { business: { timezone } } },
    json,
    now,
  }) as Record<string, unknown>;

// Google Sheets' Append or Update writes whatever is mapped, so a blank value from the model would
// erase the stored one. Nothing needs to clear a field, so blank means "not given".
test('a blank or whitespace-only name, service, or last appointment keeps the stored value', () => {
  expect(merged({ phone: '570000000001', status: 'inquiry', name: '  ', service_of_interest: '' })).toMatchObject({
    name: 'Laura Gomez',
    service_of_interest: 'Dental cleaning',
    last_appointment: '2026-11-04T09:30:00.000-05:00',
    status: 'booked',
  });
  expect(merged({ phone: '570000000001', status: 'inquiry', last_appointment: ' ' })).toMatchObject({ last_appointment: stored.last_appointment });
});

test('a non-blank update overwrites the stored value', () => {
  expect(merged({ phone: '570000000001', status: 'booked', name: ' Laura G. ', service_of_interest: 'Teeth whitening', last_appointment: '2026-11-06T08:00:00.000-05:00' }))
    .toMatchObject({ name: 'Laura G.', service_of_interest: 'Teeth whitening', last_appointment: '2026-11-06T08:00:00.000-05:00', status: 'booked' });
  // A first-time patient's lookup yields an empty placeholder, so every missing field is ''.
  expect(merged({ phone: '570000000001', status: 'inquiry' }, {})).toEqual({
    last_contact: '2026-11-04', phone: '570000000001', status: 'inquiry', name: '', service_of_interest: '', last_appointment: '',
  });
});

test('last_contact is today in business.timezone', () => {
  expect(merged({ phone: '570000000001', status: 'inquiry' }).last_contact).toBe('2026-11-04');
  expect(merged({ phone: '570000000001', status: 'inquiry' }, stored, 'Asia/Tokyo').last_contact).toBe('2026-11-05');
});
