import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listJsonFiles, readWorkflow, type Workflow, type WorkflowNode } from './lib/workflow.ts';
import { CODE_NODES, CREDENTIALS, ERROR_WORKFLOW_ID, LOAD_CONTEXT_ID } from './manifest.ts';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /\d{10,}/;
const LONG_ID_RE = /[A-Za-z0-9_-]{40,}/;
const SECRET_RE = /sk-ant-|EAA[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,}/;

// External services that must retry instead of failing a workflow run on a transient error.
const RETRY_REQUIRED_TYPES = new Set([
  'n8n-nodes-base.googleCalendar',
  'n8n-nodes-base.googleSheets',
  'n8n-nodes-base.gmail',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.postgres',
  'n8n-nodes-base.whatsApp',
]);

export function checkWorkflow(
  wf: Workflow,
  opts: { credentialIds: ReadonlySet<string>; generatedNodes: ReadonlySet<string> },
): string[] {
  const errors: string[] = [];
  // Widen past Workflow's own (optimistic) field types so a malformed or hand-edited file can be
  // reported instead of crashing the check.
  const raw: Record<string, unknown> = wf;

  for (const field of ['id', 'name', 'nodes', 'connections', 'settings']) {
    // eslint-disable-next-line security/detect-object-injection -- field is one of the fixed literals above
    if (raw[field] === undefined || raw[field] === null) errors.push(`missing ${field}`);
  }

  if (raw.pinData !== undefined) errors.push('pinData present');
  const meta = raw.meta;
  const instanceId = meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>).instanceId : undefined;
  if (instanceId !== undefined) errors.push('meta.instanceId present');

  const settings = raw.settings;
  if (settings !== null && typeof settings === 'object') {
    const s = settings as Record<string, unknown>;
    if (s.executionOrder !== 'v1') errors.push('settings.executionOrder must be v1');
    if (s.timezone !== 'America/Bogota') errors.push('settings.timezone must be America/Bogota');
    if (s.callerPolicy !== 'workflowsFromSameOwner') errors.push('settings.callerPolicy must be workflowsFromSameOwner');
    // load-context is exempt too: the error handler calls it, so naming the handler as its error workflow would loop.
    const exempt = wf.id === ERROR_WORKFLOW_ID || wf.id === LOAD_CONTEXT_ID;
    if (!exempt && s.errorWorkflow !== ERROR_WORKFLOW_ID) {
      errors.push(`settings.errorWorkflow must be ${ERROR_WORKFLOW_ID}`);
    }
  }

  const nodesValue = raw.nodes;
  const nodes = Array.isArray(nodesValue) ? (nodesValue as WorkflowNode[]) : [];
  for (const node of nodes) {
    for (const credential of Object.values(node.credentials ?? {})) {
      if (!opts.credentialIds.has(credential.id)) errors.push(`credential ${credential.id} not in manifest`);
    }

    const serialized = JSON.stringify(node.parameters);
    if (EMAIL_RE.test(serialized)) errors.push(`literal email in node ${node.name}`);
    if (PHONE_RE.test(serialized)) errors.push(`literal phone in node ${node.name}`);
    if (LONG_ID_RE.test(serialized)) errors.push(`literal long id in node ${node.name}`);
    if (SECRET_RE.test(serialized)) errors.push(`secret-like value in node ${node.name}`);

    if (node.type === 'n8n-nodes-base.code') {
      const jsCode = typeof node.parameters.jsCode === 'string' ? node.parameters.jsCode : '';
      if (!jsCode.startsWith('// Why Code:')) errors.push(`code node ${node.name} must start with // Why Code:`);
      if (!opts.generatedNodes.has(node.name)) errors.push(`code node ${node.name} is not generated from src/nodes`);
    }

    if (RETRY_REQUIRED_TYPES.has(node.type) && node.retryOnFail !== true) {
      errors.push(`node ${node.name} calls an external service without retry on fail`);
    }

    if (node.type === 'n8n-nodes-base.postgres' && node.parameters.operation === 'executeQuery') {
      const query = node.parameters.query;
      if (typeof query === 'string' && query.includes('{{')) {
        errors.push(`query in node ${node.name} must use $n parameters, not expressions`);
      }
    }
  }

  return errors;
}

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/check-workflows.ts <dir>');
    process.exitCode = 1;
    return;
  }

  const credentialIds = new Set(CREDENTIALS.map((c) => c.id));
  let failed = false;
  for (const file of listJsonFiles(dir)) {
    const generatedNodes = new Set(CODE_NODES.filter((e) => e.file === basename(file)).map((e) => e.node));
    const wf = readWorkflow(file);
    for (const message of checkWorkflow(wf, { credentialIds, generatedNodes })) {
      console.log(`${file}: ${message}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
