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
 * Reduces one `cleanup` part's tagged outcomes — one per delete attempt, plus a failure tag when
 * the search/read step itself errored — to that part's report: the count of items deleted, or
 * null the moment any outcome failed. An empty list (nothing matched, so there was nothing to
 * delete) is a success with count 0, not a failure.
 *
 * This exists because feeding a delete node's separate success and error outputs into the same
 * merge input races: n8n's internal ordering decides which item (a real count, or null) reaches
 * the merge first, so a single failed delete among several successes could be reported as a
 * success. Routing every outcome through one Aggregate into this single decision point removes
 * that race — exactly one item reaches the merge chain per part, whatever the outcome.
 */
export function run(input: CountCleanupOutcomesInput): CountCleanupOutcomesOutput {
  if (input.outcomes.some((outcome) => !outcome.ok)) return { count: null };
  return { count: input.outcomes.length };
}
