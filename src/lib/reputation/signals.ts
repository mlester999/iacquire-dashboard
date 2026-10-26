// Reading a feedback comment that came without a score. A customer who writes "this was unacceptable" and picks no star is as unhappy as one who picks one star, so a
// person should see it. The words themselves are matched by the same deliberately blunt check the inbox uses (detectEscalationSignal); this file only removes the
// phrases that name a complaint in order to deny it, so "no complaints at all" does not raise a follow-up. Pure: no I/O.

/** "no complaints", "not a single complaint", "nothing to complain about", "can't complain": a complaint named only to say there is none. */
const NEGATED_COMPLAINT = /(?:\b(?:no|not|never|zero|without|nothing)\b|n['’]t\b)[^.!?\n]{0,24}?\bcomplain\w*/gi;

/** The comment with every negated mention of a complaint taken out, so the remaining words are judged on their own. */
export function withoutNegatedComplaints(comment: string): string {
  return comment.replace(NEGATED_COMPLAINT, " ");
}
