import crypto from "node:crypto";
import { canonicalJson } from "@/lib/invoices/hash";
import { normalizeSetup, REMINDER_SUBJECT_TEMPLATE, REMINDER_TEMPLATES, REMINDER_WORDING_VERSION, type ReminderSetup } from "@/lib/invoices/reminder-text";

// Kept out of reminder-text.ts because the settings screen (a client component) imports that file for its labels, and a browser bundle cannot read node:crypto.

/**
 * The fingerprint of everything the owner authorizes: the exact wording of every reminder and the subject, which days they go on, the most that go for one invoice, and the
 * channels. Change any of it and the fingerprint differs, so the authorization no longer covers what would be sent.
 */
export function reminderAuthorizationHash(setup: ReminderSetup): string {
  return crypto.createHash("sha256").update(canonicalJson({ v: 1, wording: REMINDER_WORDING_VERSION, templates: REMINDER_TEMPLATES, subject: REMINDER_SUBJECT_TEMPLATE, setup: normalizeSetup(setup) }), "utf8").digest("hex");
}
