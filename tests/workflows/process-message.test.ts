import { expect, test } from 'vitest';
import { readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';

const wf = readWorkflow('workflows/process-message.json');
const nodesOfType = (type: string): WorkflowNode[] => wf.nodes.filter((n) => n.type === type);
const node = (name: string): WorkflowNode | undefined => wf.nodes.find((n) => n.name === name);

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
