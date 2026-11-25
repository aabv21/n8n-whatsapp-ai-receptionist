import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';

const queryOf = (file: string, name: string): string =>
  String(readWorkflow(`workflows/${file}`).nodes.find((n) => n.name === name)?.parameters.query);

test("the chat-memory session prefix is the same literal everywhere it's used", () => {
  const sessionKey = String(readWorkflow('workflows/process-message.json').nodes.find((n) => n.name === 'Postgres Chat Memory')?.parameters.sessionKey);
  const prefix = /=== 'test' \? '([^']+)'/.exec(sessionKey)?.[1] ?? '';
  expect(prefix).toBe('test:');
  expect(queryOf('retention-cleanup.json', 'Delete expired chat memory')).toContain(`'${prefix}' || m.phone`);
  expect(queryOf('dev-cleanup.json', 'Delete test memories')).toContain(`'${prefix}' || $1`);
  const recent = (readWorkflow('workflows/process-message.json').nodes.find((n) => n.name === 'Recent conversation')?.parameters.options as { queryReplacement: string }).queryReplacement;
  expect(recent).toContain(`'${prefix}'`);
});
