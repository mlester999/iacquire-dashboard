// Short messages the server hands to the accounts page (in the notice cookie, never in the address). Pure.

export interface SkippedAccount {
  name: string;
  reason: string;
}

/**
 * What happened when a person connected the Pages they chose and some could not be saved: which were not connected and why, in one message that fits the
 * notice cookie. Null when nothing was skipped. It is an error-toned notice because something the person asked for did not happen; when other accounts did
 * connect, the message says so first.
 */
export function skippedNotice(connectedCount: number, skipped: readonly SkippedAccount[], max = 300): { kind: "error"; message: string } | null {
  if (!skipped.length) return null;
  const head = connectedCount > 0 ? `Connected ${connectedCount} account${connectedCount === 1 ? "" : "s"}. ` : "";
  const lead = "Not connected: ";
  const more = (n: number) => (n > 0 ? ` and ${n} more` : "");
  const items = skipped.map((s) => `${s.name}: ${s.reason}`);
  let text = "";
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const next = `${text}${i ? " | " : ""}${items[i]}`;
    if (head.length + lead.length + next.length + more(items.length - (i + 1)).length > max) break;
    text = next;
    used = i + 1;
  }
  if (!used) {
    // Even the first one is too long for the cookie: cut it rather than lose the rest of the message.
    const room = max - head.length - lead.length - more(items.length - 1).length - 1;
    text = `${items[0].slice(0, Math.max(room, 0))}…`;
    used = 1;
  }
  return { kind: "error", message: `${head}${lead}${text}${more(items.length - used)}` };
}
