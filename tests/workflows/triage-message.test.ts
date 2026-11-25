import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import { evaluateExpression } from '../helpers/run-expression.ts';

const wf = readWorkflow('workflows/triage-message.json');
const node = (name: string) => wf.nodes.find((n) => n.name === name);

// One of the two retry exceptions in the architecture doc: 2 tries x config.triage.timeout_ms plus one
// 1000 ms wait bound how long a slow TypeSafe delays a reply before triage fails open.
test('Score message with Jev makes 2 tries, 1000 ms apart, with config.triage.timeout_ms, and fails open through its error output', () => {
  const jev = node('Score message with Jev');
  expect([jev?.retryOnFail, jev?.maxTries, jev?.waitBetweenTries]).toEqual([true, 2, 1000]);
  expect((jev?.parameters.options as { timeout?: unknown }).timeout).toBe("={{ $('Load context').item.json.config.triage.timeout_ms }}");
  expect(jev?.onError).toBe('continueErrorOutput');
  const outputs = (wf.connections['Score message with Jev'] as { main: { node: string }[][] }).main;
  expect(outputs[1]?.map((e) => e.node)).toEqual(['Blank scores on Jev failure']);
});

test("Jev's criteria say a call-back to book is not a human request, and a mild lasting ache is not an emergency", () => {
  const body = String(node('Score message with Jev')?.parameters.jsonBody);
  expect(body).toContain('or asks to be called back only to book an appointment.');
  expect(body).toContain('or a mild ache that has lasted days with no swelling, bleeding, or fever.');
});

test('emergency_only asks Jev the emergency question alone and passes the flag to Decide route', () => {
  const trigger = wf.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
  expect((trigger?.parameters.workflowInputs as { values: { name: string }[] }).values.map((v) => v.name)).toEqual(['text', 'recent_messages', 'emergency_only']);
  const body = String(node('Score message with Jev')?.parameters.jsonBody);
  expect(body).toContain("...($('Receive triage request').item.json.emergency_only === true ? {} : {");
  // Only the emergency question sits outside the spread, so the narrow call asks nothing else.
  const outside = body.split("...($('Receive triage request')")[0] ?? '';
  expect(outside).toContain('emergency: {');
  for (const other of ['asks_for_human', 'complaint', 'medical_advice', 'manipulation']) expect(outside, other).not.toContain(`${other}: {`);
  for (const name of ['Map Jev answers to scores', 'Blank scores on Jev failure']) {
    expect(String(node(name)?.parameters.jsonOutput), name).toContain("emergency_only: $('Receive triage request').item.json.emergency_only === true");
  }
});

// The body is one n8n expression, so a missing comma only shows when it is evaluated.
test('the Jev request body evaluates to valid JSON, asking one question for emergency_only and all five otherwise', () => {
  const body = String(node('Score message with Jev')?.parameters.jsonBody);
  const request = (emergencyOnly: boolean | undefined): { model: string; state: { latest_message: string }; questions: Record<string, unknown> } => {
    const value = evaluateExpression(body, {
      nodes: {
        'Load context': { config: { triage: { model: 'jev-test' } } },
        'Receive triage request': { text: 'Me duele', recent_messages: ['a', 'b', 'c', 'd'], emergency_only: emergencyOnly },
      },
    });
    return JSON.parse(JSON.stringify(value)) as ReturnType<typeof request>;
  };
  const all = ['emergency', 'asks_for_human', 'complaint', 'medical_advice', 'manipulation'];
  expect(Object.keys(request(true).questions)).toEqual(['emergency']);
  expect(Object.keys(request(false).questions)).toEqual(all);
  expect(Object.keys(request(undefined).questions)).toEqual(all);
  expect(request(false)).toMatchObject({ model: 'jev-test', state: { latest_message: 'Me duele' } });
});

test('Map Jev answers and Blank scores evaluate with the emergency_only flag, true only when asked', () => {
  const scope = (emergencyOnly: unknown, json: unknown): Parameters<typeof evaluateExpression>[1] => ({
    nodes: {
      'Load context': { config: { triage: { thresholds: { emergency: 0.6 } } } },
      'Receive triage request': { text: 'x', recent_messages: [], emergency_only: emergencyOnly },
    },
    json,
  });
  const answers = { answers: { emergency: { noul: 0.9 } } };
  for (const [flag, want] of [[true, true], [false, false], [undefined, false], ['yes', false]] as const) {
    const mapped = evaluateExpression(String(node('Map Jev answers to scores')?.parameters.jsonOutput), scope(flag, answers)) as { scores: Record<string, unknown>; emergency_only: boolean };
    expect([flag, mapped.emergency_only]).toEqual([flag, want]);
    expect(mapped.scores.emergency).toBe(0.9);
    const blank = evaluateExpression(String(node('Blank scores on Jev failure')?.parameters.jsonOutput), scope(flag, {})) as { scores: unknown; emergency_only: boolean };
    expect([flag, blank.scores, blank.emergency_only]).toEqual([flag, null, want]);
  }
});
