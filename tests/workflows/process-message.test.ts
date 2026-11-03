import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';
import { CODE_NODES, WORKFLOWS } from '../../scripts/manifest.ts';
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
  expect(inputsOf(node('Alert the team')).value.message_id).toBe("={{ $('When called').item.json.message_id }}");
  expect(inputsOf(node('notify_team')).value.message_id).toBe("={{ $('When called').first().json.message_id }}");
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
  const input = { reply: 'Te lo dejo en $225.000.', flags: { triage_failed: false }, tool_calls: [], business };
  expect(runGenerated(jsCode, input)).toEqual([{ json: { reply: business.replies.price_check, flags: { triage_failed: false, reply_replaced: true } } }]);
});
