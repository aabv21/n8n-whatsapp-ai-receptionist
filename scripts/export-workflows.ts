import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkflows } from './build-workflows.ts';
import { isExecError } from './lib/errors.ts';
import { compose, loadDotEnv } from './lib/runtime.ts';
import { listJsonFiles, readWorkflow, writeWorkflow, type Workflow } from './lib/workflow.ts';
import { CODE_NODES, WORKFLOWS } from './manifest.ts';

// Fields n8n sets on export that reflect this instance's history, not the workflow's source:
// pinned data, server bookkeeping (`active` and `versionCounter` appear once a workflow is
// published), and the instance's own identity.
const VOLATILE_FIELDS = [
  'pinData',
  'versionId',
  'activeVersionId',
  'triggerCount',
  'createdAt',
  'updatedAt',
  'shared',
  'staticData',
  'isArchived',
  'active',
  'versionCounter',
] as const;

export function normalizeWorkflow(wf: Workflow): Workflow {
  const clone: Record<string, unknown> = structuredClone(wf);
  for (const field of VOLATILE_FIELDS) Reflect.deleteProperty(clone, field);
  const meta = clone.meta;
  if (meta !== null && typeof meta === 'object') Reflect.deleteProperty(meta, 'instanceId');
  return clone as Workflow;
}

export interface ExportOptions {
  /** The host side of the bind mount n8n exports into (`/import/export/` in the container). */
  exportDir: string;
  workflowsDir: string;
  /** Runs `docker compose <args>`; tests pass a fake that writes the export files itself. */
  runCompose?: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Exports every workflow from n8n into `exportDir`, then writes each one the manifest knows,
 * normalized, to `workflowsDir`. Returns the file names written and the IDs it doesn't know.
 */
export async function exportWorkflows({ exportDir, workflowsDir, runCompose = compose }: ExportOptions): Promise<{ written: string[]; unknown: string[] }> {
  rmSync(exportDir, { recursive: true, force: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- exportDir is the caller's fixed scratch directory, not user input
  mkdirSync(exportDir, { recursive: true });
  try {
    await runCompose(['exec', '-T', 'n8n', 'n8n', 'export:workflow', '--all', '--separate', '--pretty', '--output=/import/export/']);
  } catch (err) {
    // A brand-new instance with nothing imported yet errors instead of exporting zero files.
    if (!isExecError(err) || !/No workflows found/i.test(err.stdout)) throw err;
  }

  const byId = new Map(WORKFLOWS.map((entry) => [entry.id, entry]));
  const written: string[] = [];
  const unknown: string[] = [];
  for (const file of listJsonFiles(exportDir)) {
    const wf = readWorkflow(file);
    const entry = byId.get(wf.id);
    if (!entry) {
      unknown.push(wf.id);
      continue;
    }
    writeWorkflow(join(workflowsDir, entry.file), normalizeWorkflow(wf));
    written.push(entry.file);
  }
  return { written, unknown };
}

async function main(): Promise<void> {
  loadDotEnv();

  const { unknown } = await exportWorkflows({ exportDir: '.n8n-import/export', workflowsDir: 'workflows' });
  for (const id of unknown) console.warn(`exported workflow ${id} is not in the manifest`);

  const { updated } = await buildWorkflows({ dir: 'workflows', entries: CODE_NODES, write: true });
  for (const label of updated) console.log(`regenerated ${label} (edit src/nodes, not the n8n editor)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
