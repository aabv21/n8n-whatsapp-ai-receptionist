import { expect, test } from 'vitest';
import { readWorkflow, type WorkflowNode } from '../../scripts/lib/workflow.ts';
import { CODE_NODES } from '../../scripts/manifest.ts';
import { runGenerated } from '../helpers/run-generated.ts';

const wf = readWorkflow('workflows/error-handler.json');
const node = (name: string): WorkflowNode | undefined => wf.nodes.find((n) => n.name === name);
type Edge = { node: string };
const targets = (name: string): string[] => (wf.connections[name] as { main?: Edge[][] } | undefined)?.main?.[0]?.map((e) => e.node) ?? [];

test('the failure email is composed by the generated Compose error email from the error and config.team_locale', () => {
  expect(targets('Catch workflow error')).toEqual(['Load context']);
  expect(targets('Load context')).toEqual(['Prepare error email']);
  expect(targets('Prepare error email')).toEqual(['Compose error email']);
  expect(targets('Compose error email')).toEqual(['Send failure email']);
  expect(CODE_NODES).toContainEqual(expect.objectContaining({ file: 'error-handler.json', node: 'Compose error email', source: 'src/nodes/compose-error-email.ts' }));
  const prepare = String(node('Prepare error email')?.parameters.jsonOutput);
  expect(prepare).toContain("workflow_name: $('Catch workflow error').first().json.workflow?.name");
  expect(prepare).toContain(
    "error_message: $('Catch workflow error').first().json.execution?.error?.message ?? $('Catch workflow error').first().json.trigger?.error?.message,",
  );
  expect(prepare).toContain('team_locale: $json.config.team_locale');
  const send = node('Send failure email')?.parameters;
  expect([send?.sendTo, send?.subject, send?.message]).toEqual([
    "={{ $('Load context').first().json.config.team_email }}",
    '={{ $json.subject }}',
    '={{ $json.body }}',
  ]);
});

test('the generated Compose error email writes a Spanish email inside a sandbox that freezes Object.defineProperty', () => {
  const jsCode = `Object.defineProperty = () => ({});\n${String(node('Compose error email')?.parameters.jsCode)}`;
  const input = {
    workflow_name: 'Process message', last_node: 'Resolve language', error_message: 'config.locale.default must be "en" or "es"',
    execution_url: 'http://localhost:5678/workflow/cmbProcMessage01/executions/42', now: '2026-11-04T14:05:00.000Z',
    timezone: 'America/Bogota', team_locale: 'es-CO',
  };
  expect(runGenerated(jsCode, input)).toEqual([{ json: {
    subject: '[Cumbident demo] Falló un flujo: Process message',
    body: 'Nodo que falló: Resolve language\nError: config.locale.default must be "en" or "es"\n'
      + 'Ejecución: http://localhost:5678/workflow/cmbProcMessage01/executions/42\nHora: 2026-11-04 09:05 America/Bogota',
  } }]);
});
