/** Resolve a desired policy from the most specific scope to the relevant default. */
export function resolveEffectiveHermesPolicy<T>(input: {
  internalDefault?: T | null;
  clientDefault?: T | null;
  clientOverride?: T | null;
  agentOverride?: T | null;
}): T | null {
  return input.agentOverride ?? input.clientOverride ?? input.clientDefault ?? input.internalDefault ?? null;
}
