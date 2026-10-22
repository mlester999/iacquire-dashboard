import "server-only";

/**
 * A reply that says the workflow was changed, written by a model that did not send the operations that would change it.
 *
 * The person only ever sees what the server really did, so a reply that reports a change nobody made is a lie the product must not tell. Such a reply is
 * detected here, the model is asked once or twice to either send the operations or say plainly that nothing changed, and if it still does neither the
 * person is told honestly that nothing changed (the reply is not shown).
 *
 * Deliberately narrow: only a reply that reports a change counts. A description of what a workflow does ("a task is created for the owner") or what it
 * could do is an explanation, not a claim. A report of a change is one of these, in any wording:
 *   - it opens with "Done", or with a past-tense verb of change ("Removed the wait", "Put the notification back", "Re-added…");
 *   - it says what "I" did ("I added…", "I used the Sales Assistant as the sender", "I left the trigger as it is");
 *   - it says what the workflow does "now" ("The workflow now starts when a deal is lost", "The wait is now 3 days").
 */

/** Verbs that report an edit to a workflow, in the past tense, as a reply can open with them or follow "I" with them. */
const CHANGE_VERBS = [
  "added", "removed", "changed", "updated", "set", "created", "renamed", "moved", "connected", "disconnected", "deleted", "tagged", "rebuilt", "replaced", "switched", "fixed", "made",
  "put", "took", "dropped", "restored", "re-?added", "reverted", "undid", "inserted", "swapped", "reordered", "reconnected", "linked", "cleared", "turned", "adjusted", "extended", "shortened",
  "narrowed", "limited", "edited", "rewrote", "wired", "attached", "appended", "scheduled", "configured", "built", "chose", "picked", "used", "kept", "left", "pointed", "filtered", "dropped",
  "swapped", "lengthened", "increased", "reduced", "doubled", "halved", "pushed", "pulled", "split", "merged", "duplicated", "copied", "cut", "trimmed", "expanded", "enabled", "disabled",
].join("|");

const PAST_CHANGE = new RegExp(`\\bi(?:'ve|\\s+have)?\\s+(?:just\\s+|now\\s+|also\\s+|then\\s+)?(?:${CHANGE_VERBS})\\b`, "i");
/** At the start of a reply "Set up a Slack connection first" is an instruction to the person, not a report of a change. */
const OPENING_VERBS = CHANGE_VERBS.replace("|set|", "|set(?!\\s+up\\b)|");
const DONE_OPENING = new RegExp(`^\\s*(?:done|all\\s+set|finished|okay,?\\s+done|there\\s+you\\s+go|sorted|(?:i(?:'ve|\\s+have)?\\s+)?(?:${OPENING_VERBS}))\\b`, "i");
/** "The workflow now starts…", "It now waits…", "The wait is now 3 days", "Now it sends…": a statement of the workflow's new behaviour. */
const NOW_STATE = /(?:^|[.!?]\s+)(?:(?:the|your|this)\s+)?(?:workflow|automation|trigger|wait|delay|step|task|message|notification|note|branch|check|path|flow|it|that)\b[^.!?\n]{0,70}\bnow\b|\b(?:is|are)\s+now\b|(?:^|[.!?]\s+)now\s+(?:it|the|each|every|when)\b/i;
const NEGATION = /\b(?:can(?:'|no)t|cannot|couldn't|could not|unable|isn't possible|not possible|didn't|did not|haven't|have not|no change|nothing (?:was|has been) changed|nothing changed|wasn't changed|not changed)\b/i;

/** True when the reply reads as "I made the change" (so it needs operations behind it). */
export function claimsChange(reply: string): boolean {
  const text = reply.trim();
  if (!text) return false;
  if (DONE_OPENING.test(text)) return true;
  if (NEGATION.test(text)) return false;
  return PAST_CHANGE.test(text) || NOW_STATE.test(text);
}

export const NO_OPERATIONS_REFUSAL = "your reply says the workflow was changed, but you wrote no operations block, so nothing was changed. Either send the operations block that makes the change, or say plainly that you did not change anything and why";
