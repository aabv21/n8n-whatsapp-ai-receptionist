import { expect, test } from 'vitest';
import { readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';
import { CODE_NODES } from '../../scripts/manifest.ts';
import { INVALID_ALERT_COOLDOWN_NOTE } from '../../src/nodes/shared/team-messages.ts';
import { evaluateExpression } from '../helpers/run-expression.ts';
import { runGenerated } from '../helpers/run-generated.ts';

const wf = readWorkflow('workflows/notify-team.json');
const node = (name: string): WorkflowNode | undefined => wf.nodes.find((n) => n.name === name);

type Edge = { node: string };
const branches = (name: string): Edge[][] => (wf.connections[name] as { main?: Edge[][] } | undefined)?.main ?? [];
const targets = (name: string, index: number): string[] => branches(name)[index]?.map((e) => e.node) ?? [];

/** Every `[source, branchIndex]` pair in the file whose branch lists `target`. */
function incomingEdges(target: string): [string, number][] {
  const edges: [string, number][] = [];
  for (const source of Object.keys(wf.connections)) {
    branches(source).forEach((branch, index) => {
      if (branch.some((e) => e.node === target)) edges.push([source, index]);
    });
  }
  return edges.sort();
}

const condition = (name: string): unknown =>
  (node(name)?.parameters.conditions as { conditions: { leftValue: unknown }[] }).conditions.map((c) => c.leftValue);

// One phone sending a handoff or emergency message over and over would otherwise send one email per
// message, using up the Gmail daily quota that real emergencies from other patients rely on.
test('Send alert email is reachable only through the cooldown IF, straight from a tool_failure alert, or past an invalid cooldown setting', () => {
  expect(incomingEdges('Send alert email')).toEqual([
    ['Check alert cooldown setting', 1],
    ['Is it a tool failure', 0],
    ['Was the team alerted recently', 1],
  ]);
  expect(condition('Is it a tool failure')).toEqual(["={{ $('Receive alert request').first().json.reason === 'tool_failure' }}"]);
  expect(targets('Is it a tool failure', 1)).toEqual(['Check alert cooldown setting']);
  expect(targets('Check alert cooldown setting', 0)).toEqual(['Check alert cooldown']);
  expect(targets('Check alert cooldown', 0)).toEqual(['Was the team alerted recently']);
  expect(condition('Was the team alerted recently')).toEqual(['={{ $json.alerted === true }}']);
});

// An emergency must reach the team even when the owner's config predates the setting or holds it as a
// string: the alert goes out without the cooldown, and Compose alert adds a line naming the setting.
test('a missing or invalid alert_cooldown_minutes sends the alert without the cooldown instead of stopping', () => {
  expect(condition('Check alert cooldown setting')).toEqual([
    "={{ Number.isInteger($('Load context').first().json.config.limits?.alert_cooldown_minutes) && $('Load context').first().json.config.limits.alert_cooldown_minutes >= 1 }}",
  ]);
  expect(incomingEdges('Check alert cooldown')).toEqual([['Check alert cooldown setting', 0]]);
  expect(targets('Check alert cooldown setting', 1)).toEqual(['Send alert email']);
  expect(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.stopAndError')).toEqual([]);
  expect(String(node('Prepare alert')?.parameters.jsonOutput)).toContain('alert_cooldown_minutes: $json.config.limits?.alert_cooldown_minutes');
});

test('an alert inside the cooldown returns ok and suppressed without sending', () => {
  expect(targets('Was the team alerted recently', 0)).toEqual(['Return suppressed']);
  expect(JSON.parse(String(node('Return suppressed')?.parameters.jsonOutput))).toEqual({ ok: true, suppressed: true });
  expect(branches('Return suppressed')).toEqual([]);
});

test('the cooldown asks whether this phone had an alert within config.limits.alert_cooldown_minutes', () => {
  const check = node('Check alert cooldown');
  expect(check?.type).toBe('n8n-nodes-base.postgres');
  expect(check?.parameters.query).toBe(
    "SELECT CASE WHEN $3::text IN ('emergency', 'triage_failed') THEN EXISTS (SELECT 1 FROM inbound_messages WHERE phone = $1 AND received_at > now() - make_interval(mins => $4) AND triage->'alerted_reasons' @> jsonb_build_array($3::text)) ELSE EXISTS (SELECT 1 FROM inbound_messages WHERE phone = $1 AND received_at > now() - make_interval(mins => $2) AND triage->'alerted_reasons' @> jsonb_build_array($3::text)) OR (SELECT count(*) FROM inbound_messages m, jsonb_array_elements_text(coalesce(m.triage->'alerted_reasons', '[]'::jsonb)) r WHERE m.phone = $1 AND m.received_at > now() - interval '1 hour' AND r NOT IN ('emergency', 'triage_failed')) >= $5 END AS alerted",
  );
  expect((check?.parameters.options as { queryReplacement?: unknown }).queryReplacement).toBe(
    "={{ $('Receive alert request').first().json.phone }},{{ $('Load context').first().json.config.limits.alert_cooldown_minutes }},{{ $('Receive alert request').first().json.reason }},{{ Number.isInteger($('Load context').first().json.config.limits?.emergency_alert_dedupe_minutes) && $('Load context').first().json.config.limits.emergency_alert_dedupe_minutes >= 1 ? $('Load context').first().json.config.limits.emergency_alert_dedupe_minutes : 5 }},{{ Number.isInteger($('Load context').first().json.config.limits?.max_alerts_per_phone_per_hour) && $('Load context').first().json.config.limits.max_alerts_per_phone_per_hour >= 1 ? $('Load context').first().json.config.limits.max_alerts_per_phone_per_hour : 6 }}",
  );
  // A failed check must not block the alert: the IF sees no `alerted: true` and sends.
  expect(check?.onError).toBe('continueRegularOutput');
});

// The cooldown is per phone and per reason: a voice-note alert must not silence a handoff, a
// complaint or a re-alert. An emergency is held back only by a short dedupe of its own, so a flood
// of emergencies sends one email per window while the patient still gets the reply every time, and
// every other reason shares a per-phone hourly cap.
test('an alert is held back by the same reason, an emergency only by its short dedupe, and the other reasons by an hourly cap', () => {
  const query = String(node('Check alert cooldown')?.parameters.query);
  // A failed emergency check may hide a missed emergency, so it is held back like an emergency.
  expect(query).toContain("WHEN $3::text IN ('emergency', 'triage_failed') THEN EXISTS");
  expect(query).toContain("make_interval(mins => $4) AND triage->'alerted_reasons' @> jsonb_build_array($3::text)");
  expect(query).toContain("triage->'alerted_reasons' @> jsonb_build_array($3::text)");
  expect(query).toContain("r NOT IN ('emergency', 'triage_failed')) >= $5");
  expect(query).not.toContain("'alerted_reason' =");
  // $3 is this alert's own reason, from the caller.
  const replacement = String((node('Check alert cooldown')?.parameters.options as { queryReplacement?: unknown }).queryReplacement);
  expect(replacement).toContain(",{{ $('Receive alert request').first().json.reason }},{{ ");
  // Every reason Mark team alerted stores is kept in the list the cooldown reads back.
  expect(String(node('Mark team alerted')?.parameters.query)).toContain("'alerted_reasons', coalesce(triage->'alerted_reasons', '[]'::jsonb) || jsonb_build_array($2::text)");
});

test('the emergency dedupe and the hourly cap come from config.limits, and a missing or invalid value keeps the default of 5 and 6', () => {
  const replacement = String((node('Check alert cooldown')?.parameters.options as { queryReplacement?: unknown }).queryReplacement);
  const parts = replacement.split('}},{{');
  expect(parts).toHaveLength(5);
  const evaluate = (index: number, limits: unknown): unknown =>
    evaluateExpression(`={{${(parts[index] ?? '').replace(/^=\{\{/, '').replace(/\}\}$/, '')}}}`, { nodes: { 'Load context': { config: { limits } } } });
  for (const [index, key, fallback] of [[3, 'emergency_alert_dedupe_minutes', 5], [4, 'max_alerts_per_phone_per_hour', 6]] as const) {
    expect(evaluate(index, { [key]: 2 }), key).toBe(2);
    for (const bad of [undefined, 0, -1, 1.5, '3', null]) expect(evaluate(index, { [key]: bad }), `${key} ${String(bad)}`).toBe(fallback);
    expect(evaluate(index, undefined), `${key} no limits`).toBe(fallback);
  }
});

test('only a sent alert is recorded, with its reason, against the inbound message, and the result still reports the send', () => {
  expect(targets('Send alert email', 0)).toEqual(['Mark team alerted']);
  expect(targets('Send alert email', 1)).toEqual(['Return failure']);
  expect(targets('Mark team alerted', 0)).toEqual(['Return success']);
  const mark = node('Mark team alerted');
  expect(mark?.parameters.query).toBe(
    "UPDATE inbound_messages SET triage = coalesce(triage, '{}'::jsonb) || jsonb_build_object('team_alerted', true, 'alerted_reason', $2::text, 'alerted_reasons', coalesce(triage->'alerted_reasons', '[]'::jsonb) || jsonb_build_array($2::text)) WHERE message_id = $1",
  );
  expect((mark?.parameters.options as { queryReplacement?: unknown }).queryReplacement)
    .toBe("={{ $('Receive alert request').first().json.message_id }},{{ $('Receive alert request').first().json.reason }}");
  // The email already went out, so a failed mark still returns ok.
  expect(mark?.onError).toBe('continueRegularOutput');
});

test('the trigger takes message_id, and the email reads Compose alert by name, whichever branch reached it', () => {
  const trigger = node('Receive alert request')?.parameters.workflowInputs as { values: { name: string }[] };
  expect(trigger.values.map((v) => v.name)).toContain('message_id');
  const send = node('Send alert email')?.parameters;
  expect([send?.sendTo, send?.subject, send?.message]).toEqual([
    "={{ $('Load context').first().json.config.team_email }}",
    "={{ $('Compose alert').first().json.subject }}",
    "={{ $('Compose alert').first().json.body }}",
  ]);
});

test('every alert, tool failures included, is composed by the generated Compose alert from the request and config.team_locale', () => {
  expect(targets('Load context', 0)).toEqual(['Prepare alert']);
  expect(targets('Prepare alert', 0)).toEqual(['Compose alert']);
  expect(targets('Compose alert', 0)).toEqual(['Is it a tool failure']);
  expect(CODE_NODES).toContainEqual(expect.objectContaining({ file: 'notify-team.json', node: 'Compose alert', source: 'src/nodes/compose-alert.ts' }));
  const prepare = String(node('Prepare alert')?.parameters.jsonOutput);
  for (const field of ['reason', 'phone', 'name', 'summary', 'recent_messages']) {
    expect(prepare).toContain(`${field}: $('Receive alert request').item.json.${field}`);
  }
  expect(prepare).toContain('now: $now.toISO()');
  expect(prepare).toContain('timezone: $json.business.timezone');
  expect(prepare).toContain('team_locale: $json.config.team_locale');
});

test('the generated Compose alert writes a Spanish alert inside a sandbox that freezes Object.defineProperty', () => {
  const jsCode = `Object.defineProperty = () => ({});\n${String(node('Compose alert')?.parameters.jsCode)}`;
  const input = {
    reason: 'emergency', phone: '570000000001', name: 'Laura Gomez', summary: 'Cara hinchada desde anoche',
    recent_messages: ['Hola', 'Me duele mucho la muela'], now: '2026-11-04T14:05:00.000Z', timezone: 'America/Bogota', team_locale: 'es', business_name: 'Cumbident',
    alert_cooldown_minutes: 60,
  };
  expect(runGenerated(jsCode, input)).toEqual([{ json: {
    subject: 'URGENTE [Cumbident] Urgencia odontológica: Laura Gomez',
    body: 'Motivo: Urgencia odontológica\nNombre: Laura Gomez\nTeléfono: https://wa.me/570000000001\nResumen: Cara hinchada desde anoche\n'
      + 'Hora: 2026-11-04 09:05 America/Bogota\n\nMensajes recientes:\nPaciente: Hola\nPaciente: Me duele mucho la muela',
  } }]);
});

test('the generated Compose alert adds the cooldown note in the frozen sandbox', () => {
  const jsCode = `Object.defineProperty = () => ({});\n${String(node('Compose alert')?.parameters.jsCode)}`;
  const input = {
    reason: 'emergency', phone: '570000000001', name: 'Laura Gomez', summary: 'Cara hinchada desde anoche',
    recent_messages: ['Hola'], now: '2026-11-04T14:05:00.000Z', timezone: 'America/Bogota', team_locale: 'es', business_name: 'Cumbident',
    alert_cooldown_minutes: 'x',
  };
  const [item] = runGenerated(jsCode, input) as [{ json: { body: string } }];
  expect(item.json.body.endsWith(`\n\n${INVALID_ALERT_COOLDOWN_NOTE}`)).toBe(true);
});

// A tool_failure alert used to skip every limits read; a config without limits must still alert.
test('Prepare alert passes an undefined cooldown, never throws, when config.limits is missing', () => {
  const prepared = evaluateExpression(String(node('Prepare alert')?.parameters.jsonOutput), {
    nodes: { 'Receive alert request': { reason: 'tool_failure', phone: '570000000001', name: '', summary: 'x', recent_messages: [] } },
    json: { business: { timezone: 'America/Bogota' }, config: { team_locale: 'en' } },
  }) as Record<string, unknown>;
  expect(prepared).toMatchObject({ reason: 'tool_failure', team_locale: 'en' });
  expect(prepared.alert_cooldown_minutes).toBeUndefined();
});

test('Prepare alert passes business.name for the subject tag', () => {
  const prepared = evaluateExpression(String(node('Prepare alert')?.parameters.jsonOutput), {
    nodes: { 'Receive alert request': { reason: 'emergency', phone: '570000000001', name: '', summary: 'x', recent_messages: [] } },
    json: { business: { name: 'Cumbident', timezone: 'America/Bogota' }, config: { team_locale: 'en', limits: { alert_cooldown_minutes: 60 } } },
  }) as Record<string, unknown>;
  expect(prepared.business_name).toBe('Cumbident');
});
