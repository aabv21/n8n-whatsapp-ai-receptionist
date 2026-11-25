import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';
import { CODE_NODES, WORKFLOWS } from '../../scripts/manifest.ts';
import { run as decideRoute } from '../../src/nodes/decide-route.ts';
import { ALERT_REASONS } from '../../src/nodes/shared/team-messages.ts';
import type { Business } from '../../src/nodes/types.ts';
import { evaluateExpression } from '../helpers/run-expression.ts';
import { runGenerated } from '../helpers/run-generated.ts';
import { nodesNotInsideTheirSticky, stickiesHaveOwnColors, stickySections } from '../helpers/sticky-sections.ts';

const wf = readWorkflow('workflows/process-message.json');
const nodesOfType = (type: string): WorkflowNode[] => wf.nodes.filter((n) => n.type === type);
const node = (name: string): WorkflowNode | undefined => wf.nodes.find((n) => n.name === name);

type Edge = { node: string };
const branches = (name: string): Edge[][] => (wf.connections[name] as { main?: Edge[][] } | undefined)?.main ?? [];
/** Every `[source, branchIndex]` pair in the file whose branch lists `target`. */
function incomingEdges(target: string): [string, number][] {
  const edges: [string, number][] = [];
  for (const source of Object.keys(wf.connections)) {
    branches(source).forEach((branch, index) => {
      if (branch.some((e) => e.node === target)) edges.push([source, index]);
    });
  }
  return edges;
}

interface SchemaField { id: string; removed: boolean }
const inputsOf = (n: WorkflowNode | undefined): { value: Record<string, unknown>; schema: SchemaField[] } =>
  n?.parameters.workflowInputs as { value: Record<string, unknown>; schema: SchemaField[] };

test('each agent tool calls its sub-workflow with the phone from the trigger, never from the model', () => {
  const tools = nodesOfType('@n8n/n8n-nodes-langchain.toolWorkflow');
  expect(tools.map((t) => `${t.name} ${String((t.parameters.workflowId as { value: unknown }).value)}`).sort()).toEqual([
    'book_appointment cmbBookAppt00001',
    'cancel_appointment cmbChangeAppt001',
    'check_availability cmbCheckAvail001',
    'my_appointments cmbChangeAppt001',
    'notify_team cmbNotifyTeam001',
    'reschedule_appointment cmbChangeAppt001',
    'upsert_patient cmbUpsertPatient',
  ]);
  for (const tool of tools) {
    expect((tool.parameters.workflowInputs as { value: Record<string, unknown> }).value.phone)
      .toBe("={{ $('When called').first().json.phone }}");
    expect(JSON.stringify(tool.parameters)).not.toMatch(/\$fromAI\(\s*\\?["'`]phone/);
  }
});

test('the AI Agent never retries and sends failures to its error output', () => {
  const agent = node('AI Agent');
  expect(agent?.retryOnFail).not.toBe(true);
  expect(agent?.onError).toBe('continueErrorOutput');
});

test('the chat model is Claude Haiku 5.5 with adaptive thinking and no sampling parameters', () => {
  const model = node('Anthropic Chat Model');
  expect((model?.parameters.model as { value: unknown }).value).toBe('claude-haiku-5-5');
  expect(model?.parameters.options).toEqual({ maxTokensToSample: 1024, thinkingMode: 'adaptive', effort: 'low' });
});

test('every Postgres node binds one value per Query Parameters expression', () => {
  // Below typeVersion 2.8, n8n splits each expression's string result on commas, so
  // "Hi, I'd like a cleaning, please" would turn into three bind values.
  const postgres = nodesOfType('n8n-nodes-base.postgres');
  expect(postgres.length).toBeGreaterThan(0);
  for (const pg of postgres) expect(pg.typeVersion).toBeGreaterThanOrEqual(2.8);
});

test('a handoff marks the patient handed_off without sending a name, so the name the patient gave stays', () => {
  const { value, schema } = inputsOf(node('Mark patient handed off'));
  expect(Object.keys(value).sort()).toEqual(['phone', 'status']);
  expect(schema.filter((f) => !f.removed).map((f) => f.id).sort()).toEqual(['phone', 'status']);
  expect(schema.find((f) => f.id === 'name')?.removed).toBe(true);
});

test("both of process-message's alert calls pass the message_id from the trigger, so notify-team can record the alert", () => {
  expect(inputsOf(node('Alert the team')).value.message_id).toBe("={{ $('When called').first().json.message_id }}");
  expect(inputsOf(node('notify_team')).value.message_id).toBe("={{ $('When called').first().json.message_id }}");
});

test("a triage emergency alerts with triage's own reason, emergency, the one reason only an earlier emergency holds back", () => {
  expect(branches('Route by triage')[1]?.map((e) => e.node)).toEqual(['Alert the team']);
  expect(inputsOf(node('Alert the team')).value.reason).toBe("={{ $('Triage message').first().json.notify_reason }}");
  const scores = { emergency: 0.9, asks_for_human: 0, complaint: 0, medical_advice: 0, manipulation: 0 };
  const thresholds = { emergency: 0.6, asks_for_human: 0.7, complaint: 0.7, medical_advice: 0.7, manipulation: 0.85 };
  expect(decideRoute({ scores, thresholds })).toMatchObject({ route: 'emergency', notify_reason: 'emergency' });
});

test('the prompt says the team was alerted only when the alert sent, not when the cooldown held it back', () => {
  // A suppressed alert answers ok: true too, but this message never reached the team, so the
  // agent is not told it did; it can still call notify_team, which reports the suppression.
  expect(String(node('Prepare prompt input')?.parameters.jsonOutput)).toContain(
    "team_alerted: $('Alert the team').isExecuted && $('Alert the team').first().json.ok === true && $('Alert the team').first().json.suppressed !== true,",
  );
});

// Each tool's model-filled fields, by $fromAI key. Every other field a tool sends must be fixed by
// the workflow (the trigger's own data or a literal) or removed, so the model can't fill it.
const FROM_AI_ALLOWLIST: Record<string, string[]> = {
  check_availability: ['date'],
  book_appointment: ['date', 'name', 'service', 'time'],
  upsert_patient: ['name', 'service_of_interest'],
  notify_team: ['reason', 'summary'],
  my_appointments: [],
  cancel_appointment: ['date', 'time'],
  reschedule_appointment: ['date', 'new_date', 'new_time', 'time'],
};
const fromAiKeys = (value: string): string[] => [...value.matchAll(/\$fromAI\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1] ?? '');
const TRIGGER_ONLY = /^=\{\{ \$\('When called'\)\.first\(\)\.json\.\w+ \}\}$/;
const subWorkflowInputs = (id: string): string[] => {
  const file = WORKFLOWS.find((w) => w.id === id)?.file ?? '';
  const trigger = readWorkflow(`workflows/${file}`).nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
  return (trigger?.parameters.workflowInputs as { values: { name: string }[] }).values.map((v) => v.name);
};

test('each tool lets the model fill exactly its allowlisted fields, and fixes or removes every other input', () => {
  const tools = nodesOfType('@n8n/n8n-nodes-langchain.toolWorkflow');
  expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(FROM_AI_ALLOWLIST).sort());
  for (const tool of tools) {
    const { value, schema } = inputsOf(tool);
    const modelFilled: string[] = [];
    for (const field of schema) {
      const mapped = value[field.id];
      const label = `${tool.name}.${field.id}`;
      if (field.removed) {
        expect(mapped, label).toBeUndefined();
        continue;
      }
      expect(typeof mapped, `${label} must be mapped`).toBe('string');
      const text = String(mapped);
      const keys = fromAiKeys(text);
      if (keys.length > 0) {
        expect(new Set(keys), label).toEqual(new Set([field.id]));
        modelFilled.push(field.id);
      } else if (text.startsWith('=')) {
        expect(text, `${label} may read only the trigger`).toMatch(TRIGGER_ONLY);
      }
    }
    expect(modelFilled.sort(), tool.name).toEqual(FROM_AI_ALLOWLIST[tool.name]);
    expect(Object.keys(value).filter((key) => !schema.some((f) => f.id === key)), `${tool.name} maps a field outside its schema`).toEqual([]);
    const workflowId = String((tool.parameters.workflowId as { value: unknown }).value);
    expect(schema.map((f) => f.id), `${tool.name} must map or remove every input its sub-workflow declares`)
      .toEqual(expect.arrayContaining(subWorkflowInputs(workflowId)));
  }
});

test("notify_team's reason is one of the three documented values, so the model can't claim tool_failure or emergency", () => {
  const reason = String(inputsOf(node('notify_team')).value.reason);
  expect(reason.startsWith("={{ ['unknown_treatment', 'out_of_scope', 'other'].find((reason) => reason === $fromAI('reason', ")).toBe(true);
  expect(reason.endsWith(") ?? 'other' }}")).toBe(true);
});

test('every agent reply goes through the reply check before process-message returns it', () => {
  expect(branches('Collect tool calls')[0]?.map((e) => e.node)).toEqual(['Prepare reply check']);
  expect(incomingEdges('Check reply')).toEqual([['Prepare reply check', 0]]);
  expect(incomingEdges('Reply from agent')).toEqual([['Check reply', 0]]);
  expect(CODE_NODES).toContainEqual(expect.objectContaining({ file: 'process-message.json', node: 'Check reply', source: 'src/nodes/check-reply.ts' }));
  expect(node('Prepare reply check')?.parameters.jsonOutput).toContain("reply: $('Did the agent reply').first().json.output");
  const reply = String(node('Reply from agent')?.parameters.jsonOutput);
  expect(reply).toContain('reply: $json.reply');
  expect(reply).toContain('flags: $json.flags');
  expect(reply).not.toContain("$('Did the agent reply')");
});

test('the generated Check reply node replaces an unlisted price inside a sandbox that freezes Object.defineProperty', () => {
  const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
  const jsCode = `Object.defineProperty = () => ({});\n${String(node('Check reply')?.parameters.jsCode)}`;
  const input = { reply: 'Te lo dejo en $225.000.', flags: { triage_failed: false }, tool_calls: [], business, lang: 'es' };
  expect(runGenerated(jsCode, input)).toEqual([{ json: { reply: business.replies.price_check.es, flags: { triage_failed: false, reply_replaced: true } } }]);
});

test("the generated Check reply node keeps this turn's booking confirmation when it replaces a reply", () => {
  const business = JSON.parse(readFileSync('business/business.json', 'utf8')) as Business;
  const jsCode = `Object.defineProperty = () => ({});\n${String(node('Check reply')?.parameters.jsCode)}`;
  const booking = { ok: true, event_id: 'evt-1', start: '2026-11-04T09:30:00.000-05:00', end: '2026-11-04T10:15:00.000-05:00', service: 'Dental cleaning', price_cop: 120000 };
  const input = { reply: 'Listo. Toma ibuprofeno.', flags: {}, tool_calls: [{ tool: 'book_appointment', input: {}, output: booking }], business, lang: 'es' };
  expect(runGenerated(jsCode, input)).toEqual([{ json: {
    reply: `${business.replies.medical_advice.es}\n\nSu cita quedó agendada: Limpieza dental, el miércoles 4 de noviembre de 2026 a las 9:30 a. m.\nDirección: ${business.address}`,
    flags: { reply_replaced: true },
  } }]);
  expect(runGenerated(jsCode, { ...input, lang: 'en' })).toEqual([{ json: {
    reply: `${business.replies.medical_advice.en}\n\nYour appointment is booked: Dental cleaning on Wednesday, November 4, 2026 at 9:30 AM.\nAddress: ${business.address}`,
    flags: { reply_replaced: true },
  } }]);
});

test('a new message resolves its language right after the duplicate check, before any fixed reply', () => {
  expect(branches('Is it a duplicate')[1]?.map((e) => e.node)).toEqual(['Prepare language check']);
  expect(incomingEdges('Resolve language')).toEqual([['Prepare language check', 0]]);
  expect(incomingEdges('Is it text')).toEqual([['Resolve language', 0]]);
  expect(CODE_NODES).toContainEqual(expect.objectContaining({ file: 'process-message.json', node: 'Resolve language', source: 'src/nodes/resolve-language.ts' }));
  expect(node('Prepare language check')?.parameters.jsonOutput).toBe(
    "={{ { text: $('Normalize text').item.json.text, type: $('Normalize text').item.json.type, locale: $('Load context').item.json.config.locale } }}",
  );
});

const LANG = "[$('Resolve language').first().json.lang]";

test("every fixed reply is picked in the message's language", () => {
  // Check reply, the one Code node that picks a fixed reply, is covered by its own source's tests.
  const replyNodes = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.code' && JSON.stringify(n.parameters).includes('business.replies.'));
  expect(replyNodes.map((n) => n.name).sort()).toEqual(['Reply blocked', 'Reply handed off', 'Reply handed off after failed check', 'Reply non-text', 'Reply rate limited', 'Reply urgent while paused', 'Reply with fallback']);
  for (const reply of replyNodes) {
    const output = String(reply.parameters.jsonOutput);
    const picks = [...output.matchAll(/business\.replies\.\w+/g)];
    expect(picks.length, reply.name).toBeGreaterThan(0);
    for (const pick of picks) expect(output.startsWith(LANG, pick.index + pick[0].length), `${reply.name}: ${pick[0]}`).toBe(true);
  }
});

test('the agent gets the language as a hint, and the reply check replaces in that language', () => {
  const prompt = String(node('Prepare prompt input')?.parameters.jsonOutput);
  expect(prompt).toContain("lang: $('Resolve language').first().json.lang,");
  expect(prompt).toContain("lang_detected: $('Resolve language').first().json.lang_detected");
  expect(String(node('Prepare reply check')?.parameters.jsonOutput)).toContain("lang: $('Resolve language').first().json.lang }");
});

test('the model is told to send a service by its canonical name, never a translated one', () => {
  const canonical = 'exactly its name in BUSINESS services, never a translated name';
  expect(String(inputsOf(node('book_appointment')).value.service)).toContain(canonical);
  expect(String(inputsOf(node('upsert_patient')).value.service_of_interest)).toContain(canonical);
});

test('the generated Resolve language node detects Spanish and falls back to the default inside a sandbox that freezes Object.defineProperty', () => {
  const jsCode = `Object.defineProperty = () => ({});\n${String(node('Resolve language')?.parameters.jsCode)}`;
  const config = { locale: { default: 'es' } };
  expect(runGenerated(jsCode, { text: 'Hola, ¿cuánto cuesta una limpieza?', type: 'text', ...config })).toEqual([{ json: { lang: 'es', lang_detected: true } }]);
  expect(runGenerated(jsCode, { text: 'How much is a dental cleaning?', type: 'text', ...config })).toEqual([{ json: { lang: 'en', lang_detected: true } }]);
  expect(runGenerated(jsCode, { text: '', type: 'other', ...config })).toEqual([{ json: { lang: 'es', lang_detected: false } }]);
  expect(runGenerated(jsCode, { text: 'ok', type: 'text', locale: { default: 'fr' } })).toEqual([{ json: { lang: 'en', lang_detected: false } }]);
});

// The patient is always answered: a side call that throws (notify-team's own load-context failing,
// say) must not stop the run. The failed sub-run still reaches error-handler through its own
// errorWorkflow, and the reply then reads the side call's empty result as a failure.
test('an emergency or handoff alert that fails still reaches the agent, and an agent-failure alert that fails still sends the fallback reply', () => {
  for (const name of ['Check handoff pause', 'Mark patient handed off', 'Alert the team', 'Re-alert the team', 'Alert urgent message', 'Alert failed urgency check', 'Check urgent message', 'Alert non-text message', 'Report agent failure']) {
    expect(node(name)?.onError, name).toBe('continueRegularOutput');
  }
  expect(String(node('Prepare prompt input')?.parameters.jsonOutput)).toContain("$('Alert the team').first().json.ok === true");
  // A failed handoff mark passes on an error item, so the alert and the mark read the run's one
  // message through .first(), never through item pairing that item may not carry.
  for (const name of ['Mark patient handed off', 'Alert the team']) {
    expect(JSON.stringify(inputsOf(node(name)).value), name).not.toContain("').item");
  }
  const fallback = String(node('Reply with fallback')?.parameters.jsonOutput);
  expect(fallback).toContain('reply: $json.ok === true ? $(\'Load context\').first().json.business.replies.technical_issue[');
  expect(fallback).toContain(': $(\'Load context\').first().json.business.replies.technical_issue_retry[');
});

test('the team alert carries the last six chat-memory lines plus this message', () => {
  const query = String(node('Recent conversation')?.parameters.query);
  expect(query).toContain('LIMIT 6');
  expect(query).toContain('session_id = $1');
  expect(inputsOf(node('Alert the team')).value.recent_messages).toBe(
    "={{ $('Recent conversation').first().json.thread.concat([{ role: 'patient', text: $('Normalize text').first().json.text }]) }}",
  );
});

test('a message inside the handoff pause skips triage and the agent, replies once with handed_off, and re-alerts once', () => {
  expect(branches('Is the patient over the limit')[1]?.map((e) => e.node)).toEqual(['Recent conversation']);
  expect(branches('Recent conversation')[0]?.map((e) => e.node)).toEqual(['Check handoff pause']);
  expect(branches('Check handoff pause')[0]?.map((e) => e.node)).toEqual(['Is the patient with the team']);
  expect(node('Is the patient with the team')?.type).toBe('n8n-nodes-base.if');
  expect(JSON.stringify(node('Is the patient with the team')?.parameters.conditions)).toContain('$json.paused === true');
  expect(branches('Is the patient with the team')[0]?.map((e) => e.node)).toEqual(['Check urgent message']);
  expect(branches('Is the patient with the team')[1]?.map((e) => e.node)).toEqual(['Recent patient messages']);
  expect(branches('Check urgent message')[0]?.map((e) => e.node)).toEqual(['Is it urgent']);
  expect(branches('Is it urgent')[1]?.map((e) => e.node)).toEqual(['Did the urgency check fail']);
  expect(branches('Did the urgency check fail')[1]?.map((e) => e.node)).toEqual(['Is it the first paused message']);
  expect(JSON.stringify(node('Is it the first paused message')?.parameters.conditions)).toContain("$('Check handoff pause').first().json.first_paused === true");
  expect(branches('Is it the first paused message')[0]?.map((e) => e.node)).toEqual(['Re-alert the team']);
  expect(branches('Is it the first paused message')[1]?.map((e) => e.node)).toEqual(['Reply handed off']);
  expect(branches('Re-alert the team')[0]?.map((e) => e.node)).toEqual(['Reply handed off']);
  expect(branches('Reply handed off')[0]?.map((e) => e.node).sort()).toEqual(['Return result', 'Save route']);
  expect(node('Reply handed off')?.parameters.jsonOutput).toBe(
    "={{ { reply: $('Check handoff pause').first().json.first_paused ? $('Load context').first().json.business.replies.handed_off[$('Resolve language').first().json.lang] : null, route: 'handoff_paused', flags: {}, tool_calls: [] } }}",
  );
  const realert = node('Re-alert the team');
  expect(realert?.onError).toBe('continueRegularOutput');
  expect(inputsOf(realert).value).toMatchObject({
    reason: 'handoff_followup',
    phone: "={{ $('When called').first().json.phone }}",
    name: "={{ $('When called').first().json.name }}",
    message_id: "={{ $('When called').first().json.message_id }}",
    recent_messages: inputsOf(node('Alert the team')).value.recent_messages,
  });
  expect(ALERT_REASONS as readonly string[]).toContain('handoff_followup');
  // Triage and the agent run on the unpaused branch only.
  const reachable = new Set<string>();
  const walk = (name: string): void => {
    for (const branch of branches(name)) for (const edge of branch) if (!reachable.has(edge.node)) { reachable.add(edge.node); walk(edge.node); }
  };
  walk('Check urgent message');
  expect(reachable.has('Triage message')).toBe(false);
  expect(reachable.has('AI Agent')).toBe(false);
  expect(reachable.has('Mark patient handed off')).toBe(false);
});

// An emergency written during the pause must not go silent: one narrow Jev question, then the fixed
// reply with the emergency phone and an alert that no cooldown holds back.
test('an emergency during the handoff pause gets the fixed urgent reply and an emergency alert, and any other message stays paused', () => {
  const check = node('Check urgent message');
  expect(check?.onError).toBe('continueRegularOutput');
  expect(String((check?.parameters.workflowId as { value: unknown }).value)).toBe('cmbTriageMsg0001');
  expect(inputsOf(check).value).toEqual({
    text: "={{ $('Normalize text').first().json.text }}",
    recent_messages: '={{ [] }}',
    emergency_only: '={{ true }}',
  });
  expect(JSON.stringify(node('Is it urgent')?.parameters.conditions)).toContain("$json.route === 'emergency'");
  expect(branches('Is it urgent')[0]?.map((e) => e.node)).toEqual(['Alert urgent message']);
  const alert = node('Alert urgent message');
  expect(alert?.onError).toBe('continueRegularOutput');
  expect(inputsOf(alert).value).toMatchObject({
    reason: 'emergency',
    phone: "={{ $('When called').first().json.phone }}",
    message_id: "={{ $('When called').first().json.message_id }}",
    recent_messages: inputsOf(node('Alert the team')).value.recent_messages,
  });
  expect(branches('Alert urgent message')[0]?.map((e) => e.node)).toEqual(['Reply urgent while paused']);
  expect(node('Reply urgent while paused')?.parameters.jsonOutput).toBe(
    "={{ { reply: $('Load context').first().json.business.replies.emergency_paused[$('Resolve language').first().json.lang], route: 'emergency', flags: {}, tool_calls: [] } }}",
  );
  expect(branches('Reply urgent while paused')[0]?.map((e) => e.node).sort()).toEqual(['Return result', 'Save route']);
});

test('a missing or invalid handoff_pause_hours turns the pause off instead of failing the run', () => {
  const replacement = String(node('Check handoff pause')?.parameters.options && (node('Check handoff pause')?.parameters.options as { queryReplacement: string }).queryReplacement);
  const hours = `={{${replacement.split('}},{{')[2] ?? ''}`;
  const read = (limits: unknown): unknown => evaluateExpression(hours, { nodes: { 'Load context': { config: { limits } } } });
  expect(read({ handoff_pause_hours: 12 })).toBe(12);
  for (const bad of [undefined, '12', 0, 1.5, -3, null]) expect(read({ handoff_pause_hours: bad }), String(bad)).toBe(0);
  expect(read(undefined)).toBe(0);
  expect(String(node('Check handoff pause')?.parameters.query)).toContain("route = 'handoff'");
});

test('a non-text message alerts the team as non_text, and a failed alert still sends the fixed reply', () => {
  expect(branches('Is it text')[1]?.map((e) => e.node)).toEqual(['Alert non-text message']);
  expect(branches('Alert non-text message')[0]?.map((e) => e.node)).toEqual(['Reply non-text']);
  const alert = node('Alert non-text message');
  expect(alert?.onError).toBe('continueRegularOutput');
  expect(String((alert?.parameters.workflowId as { value: unknown }).value)).toBe('cmbNotifyTeam001');
  expect(inputsOf(alert).value).toEqual({
    reason: 'non_text',
    phone: "={{ $('When called').first().json.phone }}",
    name: "={{ $('When called').first().json.name }}",
    message_id: "={{ $('When called').first().json.message_id }}",
    recent_messages: '={{ [] }}',
  });
  expect(String(node('Reply non-text')?.parameters.jsonOutput)).not.toContain('$json');
});

test('the prompt input carries retention_days from the config, so the first-message line states it', () => {
  expect(String(node('Prepare prompt input')?.parameters.jsonOutput)).toContain("retention_days: $('Load context').first().json.config.limits?.retention_days");
});

const SECTIONS: Record<string, string[]> = {
  '## Intake': [
    'Record inbound message', 'Is it a duplicate', 'Return duplicate', 'Prepare language check', 'Resolve language', 'Is it text', 'Alert non-text message', 'Reply non-text',
    'Count recent messages', 'Is the patient over the limit', 'Reply rate limited', 'Recent conversation', 'Check handoff pause', 'Is the patient with the team',
    'Check urgent message', 'Is it urgent', 'Alert urgent message', 'Reply urgent while paused', 'Did the urgency check fail', 'Alert failed urgency check', 'Reply handed off after failed check', 'Is it the first paused message', 'Re-alert the team', 'Reply handed off', 'Recent patient messages',
  ],
  '## Triage and alerts': ['Triage message', 'Save triage', 'Route by triage', 'Reply blocked', 'Mark patient handed off', 'Alert the team'],
  '## Agent': [
    'Prepare prompt input', 'Build system prompt', 'AI Agent', 'Anthropic Chat Model', 'Postgres Chat Memory', 'check_availability', 'book_appointment',
    'upsert_patient', 'notify_team', 'Did the agent reply',
  ],
  '## Reply check and result': [
    'Collect tool calls', 'Prepare reply check', 'Check reply', 'Reply from agent', 'Report agent failure', 'Reply with fallback', 'Save route', 'Return result',
  ],
};

test("sticky notes frame each section's nodes, each in its own color", () => {
  expect(stickySections(wf).map((s) => s.heading).sort()).toEqual(Object.keys(SECTIONS).sort());
  expect(nodesNotInsideTheirSticky(wf, SECTIONS)).toEqual([]);
  expect(stickiesHaveOwnColors(wf)).toBe(true);
});

test('every reason notify_team lets the model pick is one of ALERT_REASONS', () => {
  const expression = String(inputsOf(node('notify_team')).value.reason);
  const picked = [...(/\[([^\]]+)\]\.find\(/.exec(expression)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(picked).toEqual(['unknown_treatment', 'out_of_scope', 'other']);
  for (const reason of picked) expect(ALERT_REASONS as readonly (string | undefined)[]).toContain(reason);
});

test('every condition id in the workflow is unique', () => {
  const ids = wf.nodes.flatMap((n) => ((n.parameters.conditions as { conditions?: { id: string }[] } | undefined)?.conditions ?? []).map((c) => c.id));
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
});

// Each expression below is edited by hand in the workflow JSON, so a slip only shows when it runs.
test('the pause, urgent and thread expressions evaluate to what the wiring expects', () => {
  const business = { replies: { handed_off: { en: 'held', es: 'espera' }, emergency_paused: { en: 'call', es: 'llame' } } };
  const nodes = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    'Load context': { business, config: { limits: { handoff_pause_hours: 12, retention_days: 30 } } },
    'Resolve language': { lang: 'es' },
    'When called': { phone: '570000000001', message_id: 'm1', name: 'Ana', channel: 'test' },
    'Normalize text': { text: 'Hola', type: 'text' },
    'Recent conversation': { thread: [{ role: 'assistant', text: 'Hi' }] },
    'Check handoff pause': { paused: true, first_paused: true },
    'Triage message': { notify_reason: 'complaint' },
    'Recent patient messages': { recent: [] },
    ...extra,
  });
  const run = (name: string, key: string, scope: Parameters<typeof evaluateExpression>[1]): unknown =>
    evaluateExpression(String((node(name)?.parameters as Record<string, unknown>)[key]), scope);
  expect(run('Reply handed off', 'jsonOutput', { nodes: nodes() })).toEqual({ reply: 'espera', route: 'handoff_paused', flags: {}, tool_calls: [] });
  expect(run('Reply handed off', 'jsonOutput', { nodes: nodes({ 'Check handoff pause': { first_paused: false } }) })).toMatchObject({ reply: null });
  expect(run('Reply urgent while paused', 'jsonOutput', { nodes: nodes() })).toEqual({ reply: 'llame', route: 'emergency', flags: {}, tool_calls: [] });
  const condition = (name: string): string => String((node(name)?.parameters.conditions as { conditions: { leftValue: string }[] }).conditions[0]?.leftValue);
  expect(evaluateExpression(condition('Is the patient with the team'), { nodes: nodes(), json: { paused: true } })).toBe(true);
  expect(evaluateExpression(condition('Is it urgent'), { nodes: nodes(), json: { route: 'emergency' } })).toBe(true);
  expect(evaluateExpression(condition('Is it urgent'), { nodes: nodes(), json: {} })).toBe(false);
  expect(evaluateExpression(condition('Is it the first paused message'), { nodes: nodes() })).toBe(true);
  for (const name of ['Alert the team', 'Re-alert the team', 'Alert urgent message', 'Check urgent message']) {
    const values = inputsOf(node(name)).value;
    for (const [key, expression] of Object.entries(values)) {
      if (typeof expression === 'string' && expression.startsWith('=')) expect(() => evaluateExpression(expression, { nodes: nodes() }), `${name}.${key}`).not.toThrow();
    }
  }
  expect(evaluateExpression(String(inputsOf(node('Alert urgent message')).value.recent_messages), { nodes: nodes() })).toEqual([{ role: 'assistant', text: 'Hi' }, { role: 'patient', text: 'Hola' }]);
  expect(evaluateExpression(String(inputsOf(node('Check urgent message')).value.emergency_only), { nodes: nodes() })).toBe(true);
  const options = (name: string): string => (node(name)?.parameters.options as { queryReplacement: string }).queryReplacement;
  expect(options('Recent conversation').startsWith('=')).toBe(true);
  expect(evaluateExpression(options('Recent conversation'), { nodes: nodes() })).toBe('test:570000000001');
  const pauseParts = options('Check handoff pause').split('}},{{').map((part) => part);
  expect(pauseParts).toHaveLength(3);
  expect(evaluateExpression(`${pauseParts[0] ?? ''}}}`, { nodes: nodes() })).toBe('570000000001');
  expect(evaluateExpression(`={{${pauseParts[1] ?? ''}}}`, { nodes: nodes() })).toBe('m1');
  // The failed-check reply and alert run as written, with the failed check's own inputs.
  expect(run('Reply handed off after failed check', 'jsonOutput', { nodes: nodes() })).toEqual({ reply: 'espera', route: 'handoff_paused', flags: {}, tool_calls: [] });
  expect(run('Reply handed off after failed check', 'jsonOutput', { nodes: nodes({ 'Check handoff pause': { first_paused: false } }) })).toMatchObject({ reply: 'espera' });
  const failedAlert = Object.fromEntries(
    Object.entries(inputsOf(node('Alert failed urgency check')).value).map(([key, expression]) => [
      key,
      typeof expression === 'string' && expression.startsWith('=') ? evaluateExpression(expression, { nodes: nodes() }) : expression,
    ]),
  );
  expect(failedAlert).toEqual({
    reason: 'triage_failed',
    phone: '570000000001',
    name: 'Ana',
    recent_messages: [{ role: 'assistant', text: 'Hi' }, { role: 'patient', text: 'Hola' }],
    message_id: 'm1',
  });
});

// A SQL error in the pause check must not take the patient's reply with it: the error item has no
// `paused: true`, so the message takes the ordinary path and the agent answers.
test('a failed pause check continues to the ordinary path instead of failing the run', () => {
  const check = node('Check handoff pause');
  expect(check?.onError).toBe('continueRegularOutput');
  expect(branches('Check handoff pause')[0]?.map((e) => e.node)).toEqual(['Is the patient with the team']);
  const left = String((node('Is the patient with the team')?.parameters.conditions as { conditions: { leftValue: string }[] }).conditions[0]?.leftValue);
  expect(evaluateExpression(left, { json: { error: 'syntax error at or near "("' } })).toBe(false);
  expect(evaluateExpression(left, { json: {} })).toBe(false);
  expect(evaluateExpression(left, { json: { paused: false, first_paused: true } })).toBe(false);
  expect(evaluateExpression(left, { json: { paused: true, first_paused: false } })).toBe(true);
  expect(branches('Is the patient with the team')[1]?.map((e) => e.node)).toEqual(['Recent patient messages']);
});

// The emergency check can fail: Jev down, no scores, or a score that isn't a number. Staying silent
// then would treat the message as not urgent, so the patient gets the handed_off line and the team an
// alert saying the check failed. The patient is not told it is an emergency, since nobody knows.
test('a failed emergency check during the pause alerts the team as triage_failed and still sends the handed_off line', () => {
  expect(branches('Did the urgency check fail')[0]?.map((e) => e.node)).toEqual(['Alert failed urgency check']);
  const alert = node('Alert failed urgency check');
  expect(alert?.onError).toBe('continueRegularOutput');
  expect(inputsOf(alert).value).toMatchObject({
    reason: 'triage_failed',
    phone: "={{ $('When called').first().json.phone }}",
    message_id: "={{ $('When called').first().json.message_id }}",
    recent_messages: inputsOf(node('Alert the team')).value.recent_messages,
  });
  expect(branches('Alert failed urgency check')[0]?.map((e) => e.node)).toEqual(['Reply handed off after failed check']);
  expect(branches('Reply handed off after failed check')[0]?.map((e) => e.node).sort()).toEqual(['Return result', 'Save route']);
  expect(ALERT_REASONS as readonly string[]).toContain('triage_failed');
});

test('the failed-check condition is true for a Jev error, missing scores and a non-number emergency score, and false for a real answer', () => {
  const left = String((node('Did the urgency check fail')?.parameters.conditions as { conditions: { leftValue: string }[] }).conditions[0]?.leftValue);
  const decide = (scores: unknown): unknown => decideRoute({ scores: scores as never, thresholds: { emergency: 0.6, asks_for_human: 0.7, complaint: 0.7, medical_advice: 0.7, manipulation: 0.85 }, emergency_only: true });
  const failed = (json: unknown): unknown => evaluateExpression(left, { json });
  // Jev error: the sub-workflow itself threw, so the item carries no route.
  expect(failed({ error: 'boom' })).toBe(true);
  // Jev error inside triage-message: scores are blanked.
  expect(failed(decide(null))).toBe(true);
  // An answer without the emergency score, and one whose score isn't a number.
  expect(failed(decide({}))).toBe(true);
  expect(failed(decide({ emergency: 'high' }))).toBe(true);
  expect(failed(decide({ emergency: 0.1 }))).toBe(false);
});

test('each change tool fixes its own action, so the model can\'t pick another', () => {
  const actions: Record<string, string> = { my_appointments: 'list', cancel_appointment: 'cancel', reschedule_appointment: 'reschedule' };
  for (const [name, action] of Object.entries(actions)) {
    const { value } = inputsOf(node(name));
    expect(value.action, name).toBe(action);
    expect(value.phone, name).toBe("={{ $('When called').first().json.phone }}");
  }
  // Fields a tool doesn't take from the model are blank, never missing.
  expect(inputsOf(node('my_appointments')).value).toMatchObject({ date: '', time: '', new_date: '', new_time: '' });
  expect(inputsOf(node('cancel_appointment')).value).toMatchObject({ new_date: '', new_time: '' });
});
