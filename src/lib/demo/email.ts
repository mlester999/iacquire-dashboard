// What counts as an email address for the demo funnel, and the key that makes it "one demo per person". Pure and linear-time on purpose: this runs on text a stranger typed.

export const MAX_EMAIL_CHARS = 254;

const LOCAL_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+/=?^_`{|}~.-";
const LABEL_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-";

/** The address as the person typed it: trimmed and lower case. This is where the link is sent. */
export function typedEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.normalize("NFKC").trim().toLowerCase() : "";
}

/** Splits at the one "@". Anything else (none, two, nothing before or after it) is not an address. */
function parts(email: string): { local: string; domain: string } | null {
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@") || at === email.length - 1) return null;
  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

/**
 * Whether the text has the shape of an address: letters, digits and the usual symbols before the @; dotted labels after it. Plain ASCII only (the link is what proves the
 * address is real and the person's own). It is not a promise that the mailbox exists.
 */
export function looksLikeEmail(raw: unknown): boolean {
  const email = typedEmail(raw);
  if (email.length < 3 || email.length > MAX_EMAIL_CHARS) return false;
  const p = parts(email);
  if (!p || p.local.length > 64) return false;
  for (const ch of p.local) if (!LOCAL_CHARS.includes(ch)) return false;
  if (p.local.startsWith(".") || p.local.endsWith(".") || p.local.includes("..")) return false;
  if (p.domain.length > 253) return false;
  const labels = p.domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63 || label.startsWith("-") || label.endsWith("-")) return false;
    for (const ch of label) if (!LABEL_CHARS.includes(ch)) return false;
  }
  const tld = labels[labels.length - 1];
  return tld.length >= 2 && /[a-z]/.test(tld);
}

/**
 * The key of "one demo per address". Lower case; everything after a plus in the part before the @ is dropped (a+1@x.com and a+2@x.com are one mailbox); Gmail ignores dots,
 * and googlemail.com is gmail.com. Without this, one mailbox would be unlimited demos. The link goes to the address as typed, never to this key.
 */
export function normalizeProspectEmail(raw: unknown): string {
  const email = typedEmail(raw);
  const p = parts(email);
  if (!p) return email;
  let { local, domain } = p;
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.split(".").join("");
  return `${local}@${domain}`;
}

export function emailDomain(raw: unknown): string {
  return parts(typedEmail(raw))?.domain ?? "";
}

/** Whether the address is on a blocked domain, or a subdomain of one (a Super Admin lists, for example, free mail providers if the demo is for work addresses only). */
export function isBlockedDomain(raw: unknown, blocked: readonly string[]): boolean {
  const domain = emailDomain(raw);
  if (!domain) return false;
  return blocked.some((entry) => {
    const d = entry.trim().toLowerCase().replace(/^@/, "");
    return d !== "" && (domain === d || domain.endsWith(`.${d}`));
  });
}

/** A domain a Super Admin may list: dotted labels, lower case, no scheme, path or @. */
export function isDomainName(raw: string): boolean {
  const d = raw.trim().toLowerCase();
  if (d.length < 3 || d.length > 253) return false;
  const labels = d.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => label.length >= 1 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-") && [...label].every((ch) => LABEL_CHARS.includes(ch)));
}

/** The first word of a name, for a greeting. */
export const firstNameOf = (name: string | null | undefined): string => (name ?? "").trim().split(/\s+/)[0]?.slice(0, 40) ?? "";
