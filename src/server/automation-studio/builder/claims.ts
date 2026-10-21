import "server-only";

/**
 * A reply that says the workflow was changed, written by a model that did not send the operations that would change it.
 *
 * The person only ever sees what the server really did, so a reply that reports a change nobody made is a lie the product must not tell. Such a reply is
 * detected here, the model is asked once or twice to either send the operations or say plainly that nothing changed, and if it still does neither the
 * person is told honestly that nothing changed (the reply is not shown).
 *
 * Deliberately narrow: only a reply that opens like a report ("Done.") or says "I added / removed / changed ..." counts. A description of what a workflow
 * does ("a task is created for the owner") is an explanation, not a claim.
 */

const PAST_CHANGE = /\bi(?:'ve|\s+have)?\s+(?:just\s+|now\s+)?(?:added|removed|changed|updated|set|created|renamed|moved|connected|deleted|tagged|rebuilt|replaced|switched|fixed|made|put|took)\b/i;
const DONE_OPENING = /^\s*(?:done|all\s+set|finished|okay,?\s+done|there\s+you\s+go|sorted|(?:i(?:'ve|\s+have)?\s+)?(?:added|removed|changed|renamed|updated|set|moved|connected|deleted|tagged|created|switched|replaced|fixed|rebuilt|made))\b/i;
const NEGATION = /\b(?:can(?:'|no)t|cannot|couldn't|could not|unable|isn't possible|not possible|didn't|did not|haven't|have not|no change|nothing (?:was|has been) changed)/i;

/** True when the reply reads as "I made the change" (so it needs operations behind it). */
export function claimsChange(reply: string): boolean {
  const text = reply.trim();
  if (!text) return false;
  if (DONE_OPENING.test(text)) return true;
  return PAST_CHANGE.test(text) && !NEGATION.test(text);
}

export const NO_OPERATIONS_REFUSAL = "your reply says the workflow was changed, but you wrote no operations block, so nothing was changed. Either send the operations block that makes the change, or say plainly that you did not change anything and why";
