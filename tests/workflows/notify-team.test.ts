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
    "SELECT EXISTS (SELECT 1 FROM inbound_messages WHERE phone = $1 AND received_at > now() - make_interval(mins => $2) AND triage->>'team_alerted' = 'true' AND ($3::text IS DISTINCT FROM 'emergency' OR triage->>'alerted_reason' = 'emergency')) AS alerted",
  );
  expect((check?.parameters.options as { queryReplacement?: unknown }).queryReplacement).toBe(
    "={{ $('Receive alert request').first().json.phone }},{{ $('Load context').first().json.config.limits.alert_cooldown_minutes }},{{ $('Receive alert request').first().json.reason }}",
  );
  // A failed check must not block the alert: the IF sees no `alerted: true` and sends.
  expect(check?.onError).toBe('continueRegularOutput');
});

// An earlier alert of another kind, such as a question about an unlisted treatment, must not hold
// back a dental emergency: only an earlier emergency in the window does. Every other reason is
// still held back by any earlier alert, emergencies included.
test('an emergency alert is held back only by an earlier emergency, every other reason by any earlier alert', () => {
  const query = String(node('Check alert cooldown')?.parameters.query);
  expect(query).toContain("AND ($3::text IS DISTINCT FROM 'emergency' OR triage->>'alerted_reason' = 'emergency')");
  // $3 is this alert's own reason, from the caller.
  const replacement = String((node('Check alert cooldown')?.parameters.options as { queryReplacement?: unknown }).queryReplacement);
  expect(replacement.endsWith(",{{ $('Receive alert request').first().json.reason }}")).toBe(true);
  // The reason the cooldown reads back is the one Mark team alerted stored.
  expect(String(node('Mark team alerted')?.parameters.query)).toContain("'alerted_reason', $2::text");
});

test('only a sent alert is recorded, with its reason, against the inbound message, and the result still reports the send', () => {
  expect(targets('Send alert email', 0)).toEqual(['Mark team alerted']);
  expect(targets('Send alert email', 1)).toEqual(['Return failure']);
  expect(targets('Mark team alerted', 0)).toEqual(['Return success']);
  const mark = node('Mark team alerted');
  expect(mark?.parameters.query).toBe(
    "UPDATE inbound_messages SET triage = coalesce(triage, '{}'::jsonb) || jsonb_build_object('team_alerted', true, 'alerted_reason', $2::text) WHERE message_id = $1",
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
    recent_messages: ['Hola', 'Me duele mucho la muela'], now: '2026-11-04T14:05:00.000Z', timezone: 'America/Bogota', team_locale: 'es',
    alert_cooldown_minutes: 60,
  };
  expect(runGenerated(jsCode, input)).toEqual([{ json: {
    subject: '[Cumbident] Urgencia odontológica: Laura Gomez',
    body: 'Motivo: Urgencia odontológica\nNombre: Laura Gomez\nTeléfono: https://wa.me/570000000001\nResumen: Cara hinchada desde anoche\n'
      + 'Hora: 2026-11-04 09:05 America/Bogota\n\nMensajes recientes:\nHola\nMe duele mucho la muela',
  } }]);
});

test('the generated Compose alert adds the cooldown note in the frozen sandbox', () => {
  const jsCode = `Object.defineProperty = () => ({});\n${String(node('Compose alert')?.parameters.jsCode)}`;
  const input = {
    reason: 'emergency', phone: '570000000001', name: 'Laura Gomez', summary: 'Cara hinchada desde anoche',
    recent_messages: ['Hola'], now: '2026-11-04T14:05:00.000Z', timezone: 'America/Bogota', team_locale: 'es',
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
