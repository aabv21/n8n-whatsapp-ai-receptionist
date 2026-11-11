import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, loadDotEnv, waitForHealthy, waitForWebhookLive } from './lib/runtime.ts';
import { listJsonFiles, readWorkflow, type Workflow } from './lib/workflow.ts';
import { CREDENTIALS, WORKFLOWS, type WorkflowEntry } from './manifest.ts';
import { buildCredentials } from './setup-credentials.ts';

/**
 * IDs of credentials that a trigger node in `wf` needs but `available` doesn't have, in node
 * order and without duplicates. A trigger is any node whose type ends in `Trigger`, or a webhook.
 */
export function missingTriggerCredentials(wf: Workflow, available: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const node of wf.nodes) {
    const isTrigger = node.type.endsWith('Trigger') || node.type === 'n8n-nodes-base.webhook';
    if (!isTrigger) continue;
    for (const credential of Object.values(node.credentials ?? {})) {
      if (!available.has(credential.id) && !seen.has(credential.id)) {
        seen.add(credential.id);
        missing.push(credential.id);
      }
    }
  }
  return missing;
}

const WORKFLOWS_DIR = 'workflows';

/** Why setup can't confirm n8n came back after its restart, or null when it did. */
export function restartProblem(n8nUrl: string | undefined, healthy: boolean): string | null {
  if (!n8nUrl) return 'N8N_URL is not set in .env, so setup could not check that n8n came back after the restart';
  return healthy ? null : 'n8n did not become healthy after restart';
}

async function main(): Promise<void> {
  loadDotEnv();

  const hasFiles = listJsonFiles(WORKFLOWS_DIR).length > 0;
  if (hasFiles) {
    await compose(['exec', '-T', 'n8n', 'n8n', 'import:workflow', '--separate', '--input=/workflows']);
  }

  const { credentials } = buildCredentials(process.env);
  const available = new Set(credentials.map((c) => c.id));
  const credentialNames = new Map(CREDENTIALS.map((c) => [c.id, c.name]));

  const published: WorkflowEntry[] = [];
  const failures: string[] = [];
  for (const entry of WORKFLOWS) {
    const path = join(WORKFLOWS_DIR, entry.file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is dir + a manifest file name, not user input
    if (!existsSync(path)) {
      console.log(`skip ${entry.file} (missing)`);
      continue;
    }

    const wf = readWorkflow(path);
    const missing = missingTriggerCredentials(wf, available);
    if (missing.length > 0) {
      const names = missing.map((id) => credentialNames.get(id) ?? id).join(', ');
      console.log(`hold ${entry.file}: needs ${names}`);
      continue;
    }

    try {
      await compose(['exec', '-T', 'n8n', 'n8n', 'publish:workflow', `--id=${entry.id}`]);
      published.push(entry);
    } catch (err) {
      failures.push(`publish failed for ${entry.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (published.length > 0) {
    await compose(['restart', 'n8n']);
    const n8nUrl = process.env.N8N_URL;
    const problem = restartProblem(n8nUrl, n8nUrl ? await waitForHealthy(n8nUrl, 90_000) : false);
    if (problem) {
      failures.push(problem);
    } else {
      // /healthz turns healthy before the publication reconciler (every 10 s by default) registers
      // the new webhook route. The poll below is the proof; this wait spares it the common case.
      await new Promise<void>((resolve) => setTimeout(resolve, 15_000));

      if (n8nUrl) {
        for (const entry of published) {
          if (!entry.webhookPath) continue;
          const live = await waitForWebhookLive(n8nUrl, entry.webhookPath, 60_000);
          if (!live) failures.push(`webhook for ${entry.file} never came up (still 404 after the wait)`);
        }
      }
    }
  }

  for (const failure of failures) console.error(failure);
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
