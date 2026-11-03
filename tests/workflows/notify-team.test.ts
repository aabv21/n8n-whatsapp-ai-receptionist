import { expect, test } from 'vitest';
import { readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';

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
test('Send alert email is reachable only through the cooldown IF, or straight from a tool_failure alert', () => {
  expect(incomingEdges('Send alert email')).toEqual([['Is it a tool failure', 0], ['Was the team alerted recently', 1]]);
  expect(condition('Is it a tool failure')).toEqual(["={{ $('Receive alert request').first().json.reason === 'tool_failure' }}"]);
  expect(targets('Is it a tool failure', 1)).toEqual(['Check alert cooldown setting']);
  expect(targets('Check alert cooldown setting', 0)).toEqual(['Check alert cooldown']);
  expect(targets('Check alert cooldown', 0)).toEqual(['Was the team alerted recently']);
  expect(condition('Was the team alerted recently')).toEqual(['={{ $json.alerted === true }}']);
});

test('a missing or invalid alert_cooldown_minutes stops the run with a fixed message instead of turning the cooldown off', () => {
  expect(condition('Check alert cooldown setting')).toEqual([
    "={{ Number.isInteger($('Load context').first().json.config.limits.alert_cooldown_minutes) && $('Load context').first().json.config.limits.alert_cooldown_minutes >= 1 }}",
  ]);
  expect(incomingEdges('Check alert cooldown')).toEqual([['Check alert cooldown setting', 0]]);
  expect(targets('Check alert cooldown setting', 1)).toEqual(['Refuse invalid alert_cooldown_minutes']);
  const refuse = node('Refuse invalid alert_cooldown_minutes');
  expect(refuse?.type).toBe('n8n-nodes-base.stopAndError');
  expect(refuse?.parameters.errorMessage).toBe('config.limits.alert_cooldown_minutes must be an integer of 1 or more');
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
    "SELECT EXISTS (SELECT 1 FROM inbound_messages WHERE phone = $1 AND received_at > now() - make_interval(mins => $2) AND triage->>'team_alerted' = 'true') AS alerted",
  );
  expect((check?.parameters.options as { queryReplacement?: unknown }).queryReplacement)
    .toBe("={{ $('Receive alert request').first().json.phone }},{{ $('Load context').first().json.config.limits.alert_cooldown_minutes }}");
  // A failed check must not block the alert: the IF sees no `alerted: true` and sends.
  expect(check?.onError).toBe('continueRegularOutput');
});

test('only a sent alert is recorded, against the inbound message, and the result still reports the send', () => {
  expect(targets('Send alert email', 0)).toEqual(['Mark team alerted']);
  expect(targets('Send alert email', 1)).toEqual(['Return failure']);
  expect(targets('Mark team alerted', 0)).toEqual(['Return success']);
  const mark = node('Mark team alerted');
  expect(mark?.parameters.query).toBe(
    `UPDATE inbound_messages SET triage = coalesce(triage, '{}'::jsonb) || '{"team_alerted": true}' WHERE message_id = $1`,
  );
  expect((mark?.parameters.options as { queryReplacement?: unknown }).queryReplacement).toBe("={{ $('Receive alert request').first().json.message_id }}");
  // The email already went out, so a failed mark still returns ok.
  expect(mark?.onError).toBe('continueRegularOutput');
});

test('the trigger takes message_id, and the email reads Compose alert by name, whichever branch reached it', () => {
  const trigger = node('Receive alert request')?.parameters.workflowInputs as { values: { name: string }[] };
  expect(trigger.values.map((v) => v.name)).toContain('message_id');
  const send = node('Send alert email')?.parameters;
  expect([send?.sendTo, send?.subject, send?.message]).toEqual([
    "={{ $('Compose alert').first().json.config.team_email }}",
    "={{ $('Compose alert').first().json.subject }}",
    "={{ $('Compose alert').first().json.body }}",
  ]);
});
