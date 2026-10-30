import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WorkflowNode {
  name: string;
  type: string;
  typeVersion: number;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: string;
  [key: string]: unknown;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  [key: string]: unknown;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

/** Lists the `.json` files directly inside `dir`, sorted. A missing directory counts as empty. */
export function listJsonFiles(dir: string): string[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is a caller-chosen workflow directory, not user input
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

export function readWorkflow(path: string): Workflow {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a caller-chosen workflow file, not user input
  return JSON.parse(readFileSync(path, 'utf8')) as Workflow;
}

export function writeWorkflow(path: string, wf: Workflow): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a caller-chosen workflow file, not user input
  mkdirSync(dirname(path), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a caller-chosen workflow file, not user input
  writeFileSync(path, `${JSON.stringify(wf, null, 2)}\n`);
}
