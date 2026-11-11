import { runInNewContext } from 'node:vm';
import { DateTime } from 'luxon';

export interface ExpressionScope {
  /** Each earlier node's output item, by node name, as `$('<name>')` reads it. */
  nodes?: Record<string, unknown>;
  /** The current input item's JSON, as `$json`. */
  json?: unknown;
  /** The time `$now` returns. */
  now?: DateTime;
}

/**
 * Evaluates an n8n `={{ … }}` field expression the way n8n does for one item: `$('<name>')` gives
 * `.item.json` and `.first().json`, plus `$json` and `$now`. Only those three, so an expression
 * reading anything else fails here instead of passing silently.
 */
export function evaluateExpression(expression: string, scope: ExpressionScope): unknown {
  const match = /^=\{\{([\s\S]*)\}\}$/.exec(expression.trim());
  if (!match) throw new Error(`not a single ={{ }} expression: ${expression}`);
  const nodes = scope.nodes ?? {};
  const $ = (name: string): { item: { json: unknown }; first: () => { json: unknown } } => {
    if (!(name in nodes)) throw new Error(`no output for node "${name}"`);
    const json = nodes[name];
    return { item: { json }, first: () => ({ json }) };
  };
  return runInNewContext(`(${match[1] ?? ''})`, { $, $json: scope.json ?? {}, $now: scope.now ?? DateTime.now(), DateTime }) as unknown;
}
