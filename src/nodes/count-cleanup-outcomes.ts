export interface CleanupOutcome {
  ok: boolean;
}

export interface CountCleanupOutcomesInput {
  outcomes: CleanupOutcome[];
}

export interface CountCleanupOutcomesOutput {
  count: number | null;
}

/**
 * Reduces one `cleanup` part's tagged outcomes (one per delete, plus a failure tag if the search
 * itself errored) to the count deleted, or null if any outcome failed. An empty list is a success
 * with count 0.
 *
 * Feeding a delete node's success and error outputs into one merge input races: n8n's ordering
 * decides which item arrives first, so one failed delete could report as a success. One Aggregate
 * into this node sends exactly one item per part to the merge.
 */
export function run(input: CountCleanupOutcomesInput): CountCleanupOutcomesOutput {
  if (input.outcomes.some((outcome) => !outcome.ok)) return { count: null };
  return { count: input.outcomes.length };
}
