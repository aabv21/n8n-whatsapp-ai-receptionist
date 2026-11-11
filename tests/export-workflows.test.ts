import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { exportWorkflows } from '../scripts/export-workflows.ts';

const dirs = (): { exportDir: string; workflowsDir: string } => ({
  exportDir: mkdtempSync(join(tmpdir(), 'export-')),
  workflowsDir: mkdtempSync(join(tmpdir(), 'workflows-')),
});

test('exportWorkflows writes each manifest workflow normalized and skips unknown ids', async () => {
  const { exportDir, workflowsDir } = dirs();
  const runCompose = (args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
    expect(args).toContain('export:workflow');
    const known = { id: 'cmbLoadContext01', name: 'Load context', nodes: [], connections: {}, settings: {}, pinData: {}, versionId: 'v1', active: true };
    writeFileSync(join(exportDir, 'load-context.json'), JSON.stringify(known));
    writeFileSync(join(exportDir, 'x.json'), JSON.stringify({ id: 'x', name: 'Stray', nodes: [], connections: {}, settings: {} }));
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  expect(await exportWorkflows({ exportDir, workflowsDir, runCompose })).toEqual({ written: ['load-context.json'], unknown: ['x'] });
  const written = JSON.parse(readFileSync(join(workflowsDir, 'load-context.json'), 'utf8')) as Record<string, unknown>;
  expect(written.id).toBe('cmbLoadContext01');
  for (const field of ['pinData', 'versionId', 'active']) expect(written, field).not.toHaveProperty(field);
});

test("a brand-new instance's 'No workflows found' exports nothing", async () => {
  const runCompose = (): Promise<{ stdout: string; stderr: string }> => Promise.reject(Object.assign(new Error('exit 1'), { stdout: 'No workflows found', stderr: '' }));
  expect(await exportWorkflows({ ...dirs(), runCompose })).toEqual({ written: [], unknown: [] });
});

test('any other compose failure is rethrown', async () => {
  const failure = Object.assign(new Error('container not running'), { stdout: '', stderr: 'service "n8n" is not running' });
  const runCompose = (): Promise<{ stdout: string; stderr: string }> => Promise.reject(failure);
  await expect(exportWorkflows({ ...dirs(), runCompose })).rejects.toBe(failure);
});
