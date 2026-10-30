import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkflows } from './build-workflows.ts';
import { compose, loadDotEnv } from './lib/runtime.ts';
import { listJsonFiles, readWorkflow, writeWorkflow, type Workflow } from './lib/workflow.ts';
import { CODE_NODES, WORKFLOWS } from './manifest.ts';

// Fields n8n sets on every export that are never meaningful diff material: pinned test data,
// server-assigned bookkeeping, and the exporting instance's own identity.
// Ruling P15: `active` and `versionCounter` showed up once Task 4's workflows were published;
// both reflect this instance's own history (publish state, save count), not the workflow's
// source, so they're dropped the same way as the other bookkeeping fields below.
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

const EXPORT_DIR = '.n8n-import/export';

function isExecError(err: unknown): err is { stdout: string } {
  return typeof err === 'object' && err !== null && typeof (err as { stdout?: unknown }).stdout === 'string';
}

async function main(): Promise<void> {
  loadDotEnv();

  rmSync(EXPORT_DIR, { recursive: true, force: true });
  mkdirSync(EXPORT_DIR, { recursive: true });
  try {
    await compose(['exec', '-T', 'n8n', 'n8n', 'export:workflow', '--all', '--separate', '--pretty', '--output=/import/export/']);
  } catch (err) {
    // A brand-new instance with nothing imported yet errors instead of exporting zero files.
    if (!isExecError(err) || !/No workflows found/i.test(err.stdout)) throw err;
  }

  const byId = new Map(WORKFLOWS.map((entry) => [entry.id, entry]));
  for (const file of listJsonFiles(EXPORT_DIR)) {
    const wf = readWorkflow(file);
    const entry = byId.get(wf.id);
    if (!entry) {
      console.warn(`exported workflow ${wf.id} is not in the manifest`);
      continue;
    }
    writeWorkflow(join('workflows', entry.file), normalizeWorkflow(wf));
  }

  const { updated } = await buildWorkflows({ dir: 'workflows', entries: CODE_NODES, write: true });
  for (const label of updated) console.log(`regenerated ${label} (edit src/nodes, not the n8n editor)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
