import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';
import { CODE_NODES, WORKFLOWS } from '../../scripts/manifest.ts';
import { run as decideRoute } from '../../src/nodes/decide-route.ts';
import type { Business } from '../../src/nodes/types.ts';
import { runGenerated } from '../helpers/run-generated.ts';

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
    'check_availability cmbCheckAvail001',
    'notify_team cmbNotifyTeam001',
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
    reply: `${business.replies.medical_advice.es}\n\nSu cita quedó agendada: Limpieza dental, el miércoles 4 de noviembre de 2026 a las 9:30.`,
    flags: { reply_replaced: true },
  } }]);
  expect(runGenerated(jsCode, { ...input, lang: 'en' })).toEqual([{ json: {
    reply: `${business.replies.medical_advice.en}\n\nYour appointment is booked: Dental cleaning on Wednesday, November 4, 2026 at 9:30 AM.`,
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
  expect(replyNodes.map((n) => n.name).sort()).toEqual(['Reply blocked', 'Reply non-text', 'Reply rate limited', 'Reply with fallback']);
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
  for (const name of ['Mark patient handed off', 'Alert the team', 'Report agent failure']) {
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
