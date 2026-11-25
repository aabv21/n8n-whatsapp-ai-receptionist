import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import type { ToolCall } from '../../src/nodes/collect-tool-calls.ts';
import { BOOK_APPOINTMENT_TOOL, CANCEL_APPOINTMENT_TOOL, RESCHEDULE_APPOINTMENT_TOOL, toolResults } from '../../src/nodes/shared/tool-results.ts';

test("toolResults keeps only the named tool's object outputs, in order", () => {
  const calls: ToolCall[] = [
    { tool: 'book_appointment', input: {}, output: { ok: true, n: 1 } },
    { tool: 'check_availability', input: {}, output: { ok: true } },
    { tool: 'book_appointment', input: {}, output: 'not an object' },
    { tool: 'book_appointment', input: {}, output: null },
    { tool: 'book_appointment', input: {}, output: { ok: false, n: 2 } },
  ];
  expect(toolResults(calls, 'book_appointment')).toEqual([{ ok: true, n: 1 }, { ok: false, n: 2 }]);
  expect(toolResults(calls, 'upsert_patient')).toEqual([]);
});

test("the tool names check-reply reads match process-message's tool nodes", () => {
  const tools = readWorkflow('workflows/process-message.json').nodes.filter((n) => n.type === '@n8n/n8n-nodes-langchain.toolWorkflow');
  for (const tool of [BOOK_APPOINTMENT_TOOL, CANCEL_APPOINTMENT_TOOL, RESCHEDULE_APPOINTMENT_TOOL]) expect(tools.map((t) => t.name)).toContain(tool);
});
