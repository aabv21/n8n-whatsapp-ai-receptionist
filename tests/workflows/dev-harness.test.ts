import { expect, test } from 'vitest';
import { readWorkflow } from '../../scripts/lib/workflow.ts';
import { nodesOutsideTheirSticky, stickySections } from '../helpers/sticky-sections.ts';

const wf = readWorkflow('workflows/dev-harness.json');
const node = (name: string) => wf.nodes.find((n) => n.name === name);

const SECTIONS: Record<string, string[]> = {
  '## Dev harness': [],
  '## upsert-patient / find-patient': [],
  '## cleanup: prefix guard': ['Validate prefix', 'Refuse cleanup'],
  '## cleanup: Calendar and Sheets': ['Search patient events', 'Delete patient event', 'List all patient rows', 'Delete matched rows'],
  '## cleanup: Postgres and result': ['Delete test messages', 'Delete test memories', 'Shape cleanup result'],
};

test('sticky notes label each section, above or around the nodes they name', () => {
  expect(stickySections(wf).map((s) => s.heading).sort()).toEqual(Object.keys(SECTIONS).sort());
  expect(nodesOutsideTheirSticky(wf, SECTIONS)).toEqual([]);
});

// One request per call: .first() is always it, while .item would have to pair back through the
// Calendar and Sheets fan-out, which n8n can't always resolve.
test("the cleanup branch reads the request only through $('Receive dev call').first()", () => {
  for (const n of wf.nodes) expect(JSON.stringify(n.parameters), n.name).not.toContain("$('Receive dev call').item");
});

// A booking can sit as far ahead as config.limits.max_booking_days_ahead, so a fixed window would
// leave a test booking behind whenever the setting grows.
test('the cleanup Calendar search spans the booking horizon plus a day', () => {
  expect(node('Search patient events')?.parameters.timeMax).toBe(
    "={{ $now.plus({ days: $('Load context for cleanup').first().json.config.limits.max_booking_days_ahead + 1 }).toISO() }}",
  );
});

test('the cleanup sticky names the three inputs of each outcome Aggregate', () => {
  const content = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.stickyNote').map((n) => String(n.parameters.content)).join('\n');
  expect(content).toContain('the search-failure tag');
});
