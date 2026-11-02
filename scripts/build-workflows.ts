import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readWorkflow, writeWorkflow } from './lib/workflow.ts';
import { CODE_NODES, type CodeNodeEntry } from './manifest.ts';

export function wrapBundle(bundle: string, entry: Pick<CodeNodeEntry, 'source' | 'why'>): string {
  const header = `// Why Code: ${entry.why}. Generated from ${entry.source} by pnpm run build:workflows; edit the source.`;
  const footer = 'return [{ json: __node.run($input.first().json) }];';
  return `${header}\n${bundle.trim()}\n${footer}\n`;
}

// n8n's Code-node Task Runner sandbox runs generated code after `Object.defineProperty = () =>
// ({})` (@n8n/task-runner's createVmExecutableCode freezes builtins this way). esbuild's IIFE
// output attaches every named export through that same function (`__defProp(target, name, {
// get: ... })`), so under that sandbox each export silently never lands and `__node.run` comes
// back undefined. Swapping esbuild's own `__defProp` helper for a plain assignment sidesteps
// `Object.defineProperty` entirely; a plain function export needs no live binding or descriptor.
// NOTE: this patches esbuild's current codegen for this exact helper, pinned by esbuild's version
// in package.json. If a future esbuild renames or restructures it, the guard below throws instead
// of silently shipping a broken Code node; the fix is to update the needle/replacement together.
const ESBUILD_DEFINE_PROP = 'var __defProp = Object.defineProperty;';
const HARDENED_DEFINE_PROP =
  'var __defProp = (obj, key, desc) => { obj[key] = desc && "get" in desc ? desc.get() : desc.value; return obj; };';

export function hardenAgainstFrozenDefineProperty(bundle: string): string {
  if (!bundle.includes(ESBUILD_DEFINE_PROP)) {
    throw new Error("esbuild output didn't contain the expected __defProp assignment; esbuild's codegen may have changed");
  }
  return bundle.replace(ESBUILD_DEFINE_PROP, HARDENED_DEFINE_PROP);
}

export async function bundleSource(source: string): Promise<string> {
  const result = await build({
    entryPoints: [source],
    bundle: true,
    format: 'iife',
    globalName: '__node',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    charset: 'utf8',
    legalComments: 'none',
    absWorkingDir: process.cwd(),
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error(`esbuild produced no output for ${source}`);
  return hardenAgainstFrozenDefineProperty(output.text);
}

export async function buildWorkflows(opts: {
  dir: string;
  entries: readonly CodeNodeEntry[];
  write: boolean;
}): Promise<{ updated: string[]; stale: string[]; skipped: string[] }> {
  const updated: string[] = [];
  const stale: string[] = [];
  const skipped: string[] = [];

  const byFile = new Map<string, CodeNodeEntry[]>();
  for (const entry of opts.entries) {
    const entries = byFile.get(entry.file) ?? [];
    entries.push(entry);
    byFile.set(entry.file, entries);
  }

  for (const [file, entries] of byFile) {
    const path = join(opts.dir, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is dir + a manifest file name, not user input
    if (!existsSync(path)) {
      skipped.push(file);
      continue;
    }

    const wf = readWorkflow(path);
    let dirty = false;
    for (const entry of entries) {
      const node = wf.nodes.find((n) => n.name === entry.node);
      if (!node) throw new Error(`node ${entry.node} missing from ${file}`);

      const jsCode = wrapBundle(await bundleSource(entry.source), entry);
      const label = `${file} › ${entry.node}`;
      if (node.parameters.jsCode === jsCode) continue;

      if (opts.write) {
        node.parameters.jsCode = jsCode;
        dirty = true;
        updated.push(label);
      } else {
        stale.push(label);
      }
    }
    if (dirty) writeWorkflow(path, wf);
  }

  return { updated, stale, skipped };
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const result = await buildWorkflows({ dir: 'workflows', entries: CODE_NODES, write: !check });
  for (const file of result.skipped) console.log(`skip ${file} (missing)`);
  for (const label of result.updated) console.log(`updated ${label}`);
  for (const label of result.stale) console.log(`stale ${label}`);
  if (check && result.stale.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
