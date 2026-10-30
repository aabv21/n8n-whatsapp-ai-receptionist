import { expect, test } from 'vitest';
import { run } from '../../src/nodes/collect-tool-calls.ts';

test('JSON observations are parsed', () => expect(run({ intermediateSteps: [
  { action: { tool: 'check_availability', toolInput: { date: '2026-11-04' } }, observation: '{"ok":false,"reason":"closed"}' },
] })).toEqual({ tool_calls: [{ tool: 'check_availability', input: { date: '2026-11-04' }, output: { ok: false, reason: 'closed' } }] }));
test('other observations are kept as they are', () => expect(run({ intermediateSteps: [
  { action: { tool: 'notify_team', toolInput: {} }, observation: 'done' },
] }).tool_calls[0]?.output).toBe('done'));
test('no steps means no tool calls', () => expect(run({})).toEqual({ tool_calls: [] }));
// The AI Agent (v3) runs each tool as its own node and reports the observation as the JSON array of
// that node's output items; a sub-workflow tool returns one item, which is the tool's result.
test("an engine-run tool's one-item result array is unwrapped", () => expect(run({ intermediateSteps: [
  { action: { tool: 'check_availability', toolInput: { date: '2026-11-04' } }, observation: '[{"ok":false,"reason":"closed"}]' },
] }).tool_calls[0]?.output).toEqual({ ok: false, reason: 'closed' }));
