import type { Workflow } from '../../scripts/lib/workflow.ts';

/** A regular node's height on the n8n canvas; a node's position is its top-left corner. */
const NODE_HEIGHT = 100;

export interface StickySection {
  heading: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Each sticky note's first line and the rectangle it covers on the canvas. */
export function stickySections(wf: Workflow): StickySection[] {
  return wf.nodes
    .filter((n) => n.type === 'n8n-nodes-base.stickyNote')
    .map((n) => {
      const [left, top] = n.position as [number, number];
      return {
        heading: String(n.parameters.content).split('\n')[0] ?? '',
        left,
        right: left + Number(n.parameters.width),
        top,
        bottom: top + Number(n.parameters.height),
      };
    });
}

/**
 * The names, from `sections`, of nodes their section's sticky doesn't label: a node must sit inside
 * the note's x-span and either wholly below the note or wholly inside it, never under its top edge
 * or cut by its bottom edge.
 */
export function nodesOutsideTheirSticky(wf: Workflow, sections: Record<string, string[]>): string[] {
  const stickies = stickySections(wf);
  const outside: string[] = [];
  for (const [heading, names] of Object.entries(sections)) {
    const sticky = stickies.find((s) => s.heading === heading);
    for (const name of names) {
      const [x, y] = (wf.nodes.find((n) => n.name === name)?.position as [number, number] | undefined) ?? [];
      const below = sticky !== undefined && y !== undefined && y >= sticky.bottom;
      const inside = sticky !== undefined && y !== undefined && y > sticky.top && y + NODE_HEIGHT <= sticky.bottom;
      if (!sticky || x === undefined || x < sticky.left || x > sticky.right || !(below || inside)) outside.push(`${heading}: ${name}`);
    }
  }
  return outside;
}
