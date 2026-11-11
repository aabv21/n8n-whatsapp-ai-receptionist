/** True only for an integer of 1 or more: the shape every `config.limits.*` count and duration must have. */
export function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}
