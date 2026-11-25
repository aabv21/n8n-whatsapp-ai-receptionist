import type { Workflow } from '../../scripts/lib/workflow.ts';

/** A regular node's height on the n8n canvas; a node's position is its top-left corner. */
const NODE_HEIGHT = 100;
/** A regular node's width on the n8n canvas. */
const NODE_WIDTH = 100;

export interface StickySection {
  heading: string;
  /** The sticky note's `color` parameter, 1 to 7. */
  color: number | undefined;
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
        color: typeof n.parameters.color === 'number' ? n.parameters.color : undefined,
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

/**
 * The names, from `sections`, of nodes their section's sticky doesn't enclose: a node's whole box
 * must sit inside the note's rectangle, so each note frames its section instead of only heading it.
 */
export function nodesNotInsideTheirSticky(wf: Workflow, sections: Record<string, string[]>): string[] {
  const stickies = stickySections(wf);
  const outside: string[] = [];
  for (const [heading, names] of Object.entries(sections)) {
    const sticky = stickies.find((s) => s.heading === heading);
    for (const name of names) {
      const [x, y] = (wf.nodes.find((n) => n.name === name)?.position as [number, number] | undefined) ?? [];
      const inside =
        sticky !== undefined && x !== undefined && y !== undefined &&
        x >= sticky.left && x + NODE_WIDTH <= sticky.right && y >= sticky.top && y + NODE_HEIGHT <= sticky.bottom;
      if (!inside) outside.push(`${heading}: ${name}`);
    }
  }
  return outside;
}

/** True when every sticky note in `wf` has a `color` of 1 to 7 that no other note in it shares. */
export function stickiesHaveOwnColors(wf: Workflow): boolean {
  const colors = stickySections(wf).map((s) => s.color);
  return colors.every((c) => c !== undefined && c >= 1 && c <= 7) && new Set(colors).size === colors.length;
}
