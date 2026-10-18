// Which channels a form's consent wording covers. Pure and free of imports, so the builder's checks (spec.ts), processing (logic.ts and
// src/server/crm/forms/process.ts) and the builder screen all read the words the same way.
//
// Each channel counts only when the wording names it explicitly, so a person is never contacted on a channel the words they agreed to
// didn't mention: "email" for email, "text" or "SMS" for text messages (not "message" on its own, and not "WhatsApp"), "WhatsApp" for
// WhatsApp. Wording that names no channel ("Send me news and offers") records no consent at all; the builder warns about it.

export type ConsentChannel = "email" | "sms" | "whatsapp";

/** Whether consent wording names email ("email", "e-mail", "emails"). */
export const coversEmail = (wording: string) => /\be-?mail(?:s|ed|ing)?\b/i.test(wording);
/** Whether consent wording names text messages ("text", "texts", "texting", "text message", "SMS"). "Message" alone or "WhatsApp" doesn't. */
export const coversTexting = (wording: string) => /\b(?:texts?|texting|texted|sms)\b/i.test(wording);
/** Whether consent wording names WhatsApp. */
export const coversWhatsapp = (wording: string) => /\bwhats\s?app\b/i.test(wording);

/** The channels consent wording names, whatever addresses were given. */
export function namedChannels(wording: string): ConsentChannel[] {
  const out: ConsentChannel[] = [];
  if (!wording.trim()) return out;
  if (coversEmail(wording)) out.push("email");
  if (coversTexting(wording)) out.push("sms");
  if (coversWhatsapp(wording)) out.push("whatsapp");
  return out;
}

/**
 * The channels consent wording covers for the addresses that count: only channels the wording names, and only for an address the
 * submission itself gave that belongs to the contact it was added to (the caller works that out).
 */
export function consentChannels(wording: string, has: { email: boolean; phone: boolean }): ConsentChannel[] {
  return namedChannels(wording).filter((c) => (c === "email" ? has.email : has.phone));
}
