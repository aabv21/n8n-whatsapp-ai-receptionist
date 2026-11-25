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

/**
 * Splits a string field that starts with `=` into the bodies of its `{{ … }}` segments, and lists what is wrong with the
 * braces. n8n reads a `}}` outside any segment as literal text and an unclosed `{{` as plain text too, so neither one fails
 * at import: the field just carries the wrong value at run time.
 */
function segments(text: string): { bodies: string[]; problems: string[] } {
  const bodies: string[] = [];
  const problems: string[] = [];
  let pos = 1;
  for (;;) {
    const open = text.indexOf('{{', pos);
    const stray = text.indexOf('}}', pos);
    if (stray !== -1 && (open === -1 || stray < open)) {
      problems.push(`stray }} at ${String(stray)}`);
      pos = stray + 2;
      continue;
    }
    if (open === -1) break;
    const close = text.indexOf('}}', open + 2);
    if (close === -1) {
      problems.push(`unclosed {{ at ${String(open)}`);
      break;
    }
    bodies.push(text.slice(open + 2, close));
    pos = close + 2;
  }
  return { bodies, problems };
}

/** Compiles one segment body the way n8n would evaluate it; the function is never called, so the stubbed globals are just parameter names. */
function compileProblem(body: string): string | null {
  try {
    new Script(`(function (${GLOBALS.join(', ')}) { return (${body}); })`);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Every problem in one field: brace problems, then each segment that doesn't compile or holds a bad `$fromAI` call. */
function fieldProblems(text: string): string[] {
  const { bodies, problems } = segments(text);
  const found = [...problems];
  for (const body of bodies) {
    const compile = compileProblem(body);
    if (compile !== null) found.push(compile);
    for (const args of fromAiArguments(body)) {
      try {
        if (args === null) throw new Error('$fromAI never closes');
        const values = runInNewContext(`[${args}]`) as unknown[];
        if (values.length < 2 || values.length > 4 || values.some((v) => typeof v !== 'string')) throw new Error(`$fromAI arguments are ${JSON.stringify(values)}`);
      } catch (err) {
        found.push((err as Error).message);
      }
    }
  }
  return found;
}

const fields = listJsonFiles('workflows').flatMap((file) => {
  const wf = readWorkflow(file);
  return [...strings(wf.nodes, `${file} nodes`)].filter(([path, text]) => text.startsWith('=') && !path.endsWith('.jsCode')).map(([where, text]) => ({ where, text }));
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

test('the workflows hold expressions for this test to check', () => expect(fields.length).toBeGreaterThan(100));

test('every string field that starts with = has balanced {{ }}, compiles in every segment, and calls $fromAI with plain strings', () => {
  const broken = fields.flatMap(({ where, text }) => fieldProblems(text).map((problem) => `${where}: ${problem}`));
  expect(broken).toEqual([]);
});

test('the check reaches mixed-text fields such as the Postgres queryReplacement lists', () => {
  expect(fields.some(({ text }) => !text.startsWith('={{') && text.includes('{{'))).toBe(true);
  expect(fields.some(({ where, text }) => where.endsWith('.queryReplacement') && segments(text).bodies.length > 1)).toBe(true);
});

const FROM_AI = "$fromAI('new_date', 'The current day of the appointment, as YYYY-MM-DD', 'string')";

test.each([
  ['a stray }} after a $fromAI call', `={{ ${FROM_AI} }} }}`, `={{ ${FROM_AI} }}`],
  ['a syntax error in one segment of a queryReplacement', "={{ $('When called').item.json.phone }},{{ $('When called').item.json.message_id ) }}", "={{ $('When called').item.json.phone }},{{ $('When called').item.json.message_id }}"],
  ['an apostrophe inside a $fromAI in mixed text', "=day {{ $fromAI('new_date', 'The patient's new day', 'string') }}", `=day {{ ${FROM_AI} }}`],
  ['an unclosed {{', '=day {{ $json.day', '=day {{ $json.day }}'],
])('the field check catches %s', (_name, broken, valid) => {
  expect(fieldProblems(broken)).not.toEqual([]);
  expect(fieldProblems(valid)).toEqual([]);
});
