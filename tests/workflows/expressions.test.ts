import { runInNewContext, Script } from 'node:vm';
import { expect, test } from 'vitest';
import { listJsonFiles, readWorkflow } from '../../scripts/lib/workflow.ts';

// n8n's expression globals, stubbed as parameters so the body only has to compile, never run.
const GLOBALS = [
  '$', '$json', '$binary', '$input', '$node', '$items', '$item', '$now', '$today', '$env', '$vars', '$workflow', '$execution', '$prevNode',
  '$itemIndex', '$runIndex', '$parameter', '$fromAI', '$jmespath', '$if', '$min', '$max', '$ifEmpty', '$secrets', '$self', 'DateTime', 'Duration', 'Interval',
];

/** Every string in a workflow's JSON, with the path it was found at. */
function* strings(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* strings(item, `${path}[${String(i)}]`);
  else if (typeof value === 'object' && value !== null) for (const [key, item] of Object.entries(value)) yield* strings(item, `${path}.${key}`);
}

/** The body of a field that is exactly one `={{ … }}` expression; mixed text such as `=a {{ b }}` isn't one. */
function singleExpression(text: string): string | null {
  if (!text.startsWith('={{') || !text.endsWith('}}')) return null;
  const inner = text.slice(3, -2);
  return inner.includes('}}') ? null : inner;
}

const expressions = listJsonFiles('workflows').flatMap((file) => {
  const wf = readWorkflow(file);
  return [...strings(wf.nodes, `${file} nodes`)].flatMap(([path, text]) => {
    const body = singleExpression(text);
    return body === null ? [] : [{ where: path, body }];
  });
});

/** The text between the parentheses of each `$fromAI(` call, skipping quoted strings, or null when they never close. */
function fromAiArguments(body: string): (string | null)[] {
  const calls: (string | null)[] = [];
  let from = body.indexOf('$fromAI(');
  while (from !== -1) {
    let depth = 0;
    let quote = '';
    let end = -1;
    for (let i = from + '$fromAI'.length; i < body.length && end === -1; i++) {
      const ch = body.charAt(i);
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) end = i;
    }
    calls.push(end === -1 ? null : body.slice(from + '$fromAI('.length, end));
    from = body.indexOf('$fromAI(', from + 1);
  }
  return calls;
}

test('the workflows hold expressions for this test to check', () => expect(expressions.length).toBeGreaterThan(100));

test('every ={{ }} expression in every workflow compiles as JavaScript', () => {
  const broken: string[] = [];
  for (const { where, body } of expressions) {
    try {
      // Compiling only: the function is never called, so the stubbed globals are just parameter names.
      new Script(`(function (${GLOBALS.join(', ')}) { return (${body}); })`);
    } catch (err) {
      broken.push(`${where}: ${(err as Error).message}`);
    }
  }
  expect(broken).toEqual([]);
});

test('every $fromAI call closes and takes a key, a description and a type as plain strings', () => {
  const broken: string[] = [];
  for (const { where, body } of expressions) {
    for (const args of fromAiArguments(body)) {
      try {
        if (args === null) throw new Error('never closes');
        const values = runInNewContext(`[${args}]`) as unknown[];
        if (values.length < 2 || values.length > 4 || values.some((v) => typeof v !== 'string')) throw new Error(`arguments are ${JSON.stringify(values)}`);
      } catch (err) {
        broken.push(`${where}: ${(err as Error).message}`);
      }
    }
  }
  expect(broken).toEqual([]);
});
