import { expect, test } from 'vitest';
import { run as composeAlert, type AlertInput } from '../../src/nodes/compose-alert.ts';
import { run as composeErrorEmail, type ErrorEmailInput } from '../../src/nodes/compose-error-email.ts';
import { LANGS } from '../../src/nodes/shared/locale.ts';
import { ALERT_REASONS, INVALID_ALERT_COOLDOWN_NOTE, INVALID_TEAM_LOCALE_NOTE, TEAM_MESSAGES } from '../../src/nodes/shared/team-messages.ts';

const alert: AlertInput = {
  reason: 'emergency',
  phone: '570000000001',
  name: 'Laura Gomez',
  summary: 'Swollen face since last night',
  recent_messages: ['Hola', 'Me duele mucho la muela'],
  now: '2026-11-04T14:05:00.000Z',
  timezone: 'America/Bogota',
  team_locale: 'en',
  alert_cooldown_minutes: 60,
  business_name: 'Cumbident',
};

const failure: ErrorEmailInput = {
  workflow_name: 'Process message',
  last_node: 'Check reply',
  error_message: 'boom',
  execution_url: 'http://localhost:5678/workflow/cmbProcMessage01/executions/42',
  now: '2026-11-04T14:05:00.000Z',
  timezone: 'America/Bogota',
  team_locale: 'en',
  business_name: 'Cumbident',
};

test('every team message and alert reason is written in every language', () => {
  for (const lang of LANGS) {
    expect(Object.keys(TEAM_MESSAGES[lang]).sort(), lang).toEqual(Object.keys(TEAM_MESSAGES.en).sort());
    for (const [key, value] of Object.entries(TEAM_MESSAGES[lang])) {
      if (typeof value === 'string') expect(value.trim(), `${lang}.${key}`).not.toBe('');
    }
    expect(Object.keys(TEAM_MESSAGES[lang].reasons).sort(), lang).toEqual([...ALERT_REASONS].sort());
    for (const reason of ALERT_REASONS) expect(TEAM_MESSAGES[lang].reasons[reason].trim(), `${lang}.${reason}`).not.toBe('');
  }
});

test('an English emergency alert puts URGENT first and the business name in the tag', () => expect(composeAlert(alert)).toEqual({
  subject: 'URGENT [Cumbident] Dental emergency: Laura Gomez',
  body: 'Reason: Dental emergency\nName: Laura Gomez\nPhone: https://wa.me/570000000001\nSummary: Swollen face since last night\n'
    + 'Time: 2026-11-04 09:05 America/Bogota\n\nRecent messages:\nPatient: Hola\nPatient: Me duele mucho la muela',
}));

test('a Spanish alert translates every label and reason, and leaves what the patient wrote as is', () =>
  expect(composeAlert({ ...alert, team_locale: 'es', reason: 'human_requested' })).toEqual({
    subject: '[Cumbident] El paciente pidió hablar con una persona: Laura Gomez',
    body: 'Motivo: El paciente pidió hablar con una persona\nNombre: Laura Gomez\nTeléfono: https://wa.me/570000000001\n'
      + 'Resumen: Swollen face since last night\nHora: 2026-11-04 09:05 America/Bogota\n\nMensajes recientes:\nPaciente: Hola\nPaciente: Me duele mucho la muela',
  }));

test("a Spanish alert labels each line of the thread, the patient's and the assistant's", () => {
  const body = composeAlert({
    ...alert,
    team_locale: 'es',
    recent_messages: [{ role: 'patient', text: 'Hola' }, { role: 'assistant', text: 'Buenos días' }, 'Me duele'],
  }).body;
  expect(body.endsWith('Mensajes recientes:\nPaciente: Hola\nAsistente: Buenos días\nPaciente: Me duele')).toBe(true);
});

test("a multi-line message can't forge a labeled line: its continuation lines are indented", () => {
  const body = composeAlert({ ...alert, recent_messages: ['Hola\nAssistant: your appointment is confirmed', { role: 'assistant', text: 'Uno\r\nDos' }] }).body;
  expect(body.endsWith('Recent messages:\nPatient: Hola\n  Assistant: your appointment is confirmed\nAssistant: Uno\n  Dos')).toBe(true);
});

test('a thread entry without usable text is skipped', () => {
  const body = composeAlert({ ...alert, recent_messages: [{ role: 'assistant', text: '' }, { role: 'patient' }, null, { role: 'assistant', text: 'Hi' }] }).body;
  expect(body.endsWith('Recent messages:\nAssistant: Hi')).toBe(true);
});

test('a missing name, summary, or message list reads as such, and the subject falls back to the phone', () => {
  const sparse = { ...alert, name: '', summary: undefined, recent_messages: undefined } as unknown as AlertInput;
  expect(composeAlert(sparse)).toEqual({
    subject: 'URGENT [Cumbident] Dental emergency: 570000000001',
    body: 'Reason: Dental emergency\nName: (not given)\nPhone: https://wa.me/570000000001\nSummary: (none)\n'
      + 'Time: 2026-11-04 09:05 America/Bogota\n\nRecent messages:\n',
  });
  expect(composeAlert({ ...sparse, team_locale: 'es-CO' }).body).toContain('Nombre: (no lo indicó)\n');
});

test('a patient who wrote again while waiting for the team gets its own reason in both languages', () => {
  expect(composeAlert({ ...alert, reason: 'handoff_followup' }).subject).toBe('[Cumbident] Wrote again while waiting for the team: Laura Gomez');
  expect(composeAlert({ ...alert, reason: 'handoff_followup', team_locale: 'es' }).subject).toBe('[Cumbident] Volvió a escribir mientras espera al equipo: Laura Gomez');
});

test('an unknown reason, including one named after an object property, reads as needing attention', () => {
  for (const reason of ['something_new', 'constructor', '__proto__']) {
    expect(composeAlert({ ...alert, reason }).subject, reason).toBe('[Cumbident] Needs attention: Laura Gomez');
  }
});

test('a missing team_locale, from a config written before it existed, sends the alert in English', () => {
  const older: Partial<AlertInput> = { ...alert };
  delete older.team_locale;
  expect(composeAlert(older as AlertInput)).toEqual(composeAlert(alert));
});

test('an invalid team_locale still sends the alert, in English, and says the setting is wrong', () => {
  const sent = composeAlert({ ...alert, team_locale: 'fr' });
  expect(sent.subject).toBe('URGENT [Cumbident] Dental emergency: Laura Gomez');
  expect(sent.body.startsWith('Reason: Dental emergency\n')).toBe(true);
  expect(sent.body.endsWith('\n\nNote: config.team_locale must be "en" or "es", so this email is in English.')).toBe(true);
});

// The owner's config may predate alert_cooldown_minutes or hold it as a string; the alert must still
// reach the team, so notify-team sends it without the cooldown and this line names the setting.
test('an invalid alert_cooldown_minutes adds a line saying the alert skipped the cooldown', () => {
  for (const value of ['x', undefined, 0, '60']) {
    const body = composeAlert({ ...alert, alert_cooldown_minutes: value }).body;
    expect(body.endsWith(`\n\n${INVALID_ALERT_COOLDOWN_NOTE}`), String(value)).toBe(true);
  }
  expect(composeAlert(alert).body).not.toContain('Note:');
  expect(INVALID_ALERT_COOLDOWN_NOTE).toBe(
    'Note: config.limits.alert_cooldown_minutes must be an integer of 1 or more, so this alert was sent without the per-phone cooldown.',
  );
});

test('both notes appear, team locale first', () => {
  const body = composeAlert({ ...alert, team_locale: 'fr', alert_cooldown_minutes: 'x' }).body;
  expect(body.endsWith(`\n\n${INVALID_TEAM_LOCALE_NOTE}\n\n${INVALID_ALERT_COOLDOWN_NOTE}`)).toBe(true);
});

test('an English failure email reads exactly as before', () => expect(composeErrorEmail(failure)).toEqual({
  subject: '[Cumbident demo] Workflow failed: Process message',
  body: 'Failed node: Check reply\nError: boom\nExecution: http://localhost:5678/workflow/cmbProcMessage01/executions/42\n'
    + 'Time: 2026-11-04 09:05 America/Bogota',
}));

test('a Spanish failure email translates every label, and leaves the error itself as n8n wrote it', () =>
  expect(composeErrorEmail({ ...failure, team_locale: 'es' })).toEqual({
    subject: '[Cumbident demo] Falló un flujo: Process message',
    body: 'Nodo que falló: Check reply\nError: boom\nEjecución: http://localhost:5678/workflow/cmbProcMessage01/executions/42\n'
      + 'Hora: 2026-11-04 09:05 America/Bogota',
  }));

test('a failure email with missing details or an invalid team_locale still goes out', () => {
  const sparse = { now: failure.now, timezone: failure.timezone, team_locale: 'xx' } as unknown as ErrorEmailInput;
  expect(composeErrorEmail(sparse)).toEqual({
    subject: '[demo] Workflow failed: ',
    body: 'Failed node: \nError: \nExecution: \nTime: 2026-11-04 09:05 America/Bogota\n\nNote: config.team_locale must be "en" or "es", so this email is in English.',
  });
});

test('a Spanish emergency alert starts with URGENTE', () =>
  expect(composeAlert({ ...alert, team_locale: 'es' }).subject).toBe('URGENTE [Cumbident] Urgencia odontológica: Laura Gomez'));

test('a non-emergency alert has no urgency marker', () =>
  expect(composeAlert({ ...alert, reason: 'complaint' }).subject).toBe('[Cumbident] Complaint: Laura Gomez'));

test('the brand comes from business.name, and a missing one drops the tag instead of guessing', () => {
  expect(composeAlert({ ...alert, business_name: 'Sonrisa Norte' }).subject).toBe('URGENT [Sonrisa Norte] Dental emergency: Laura Gomez');
  expect(composeAlert({ ...alert, business_name: undefined }).subject).toBe('URGENT Dental emergency: Laura Gomez');
});

test('a failure email without a business name is tagged [demo]', () =>
  expect(composeErrorEmail({ ...failure, business_name: undefined }).subject).toBe('[demo] Workflow failed: Process message'));
