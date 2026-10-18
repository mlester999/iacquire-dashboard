// A small, shared check for text that looks like a credential: a password, an API key or token, a private key, or a URL that carries one.
// Pure (no I/O), so a form can warn as someone types and the server refuses the same strings.
//
// It is deliberately simple and errs on the side of refusing: places that use it (workspace configuration values, which are inserted into
// customer messages) never need a secret, and secrets belong in the encrypted credential store. It recognises the published shapes of common
// providers' keys, assignments such as "password: …", credentials inside URLs, and long random strings that read like a key. It does not
// flag ordinary business text, web addresses, phone numbers, email addresses, colours or UUIDs on their own.

export type SecretKind = "private_key" | "jwt" | "provider_key" | "url_credentials" | "secret_parameter" | "webhook_url" | "secret_assignment" | "random_token";

export interface SecretMatch {
  kind: SecretKind;
  /** What it looks like, for a sentence: "an API key or token". */
  label: string;
}

const LABELS: Record<SecretKind, string> = {
  private_key: "a private key",
  jwt: "a signed access token (JWT)",
  provider_key: "an API key or access token",
  url_credentials: "a web address with a username and password in it",
  secret_parameter: "a web address that carries a key or token",
  webhook_url: "a private webhook address",
  secret_assignment: "a password or secret",
  random_token: "a long random string, like a key or token",
};

/** Published key and token shapes. Each is specific enough that ordinary text doesn't match. */
const PROVIDER_PATTERNS: RegExp[] = [
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/, // Stripe-style secret and restricted keys (also PayMongo)
  /\bwhsec_[A-Za-z0-9+/=]{10,}/, // webhook signing secrets
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/, // Anthropic and OpenAI keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab personal access tokens
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API keys
  /\bya29\.[0-9A-Za-z_-]{20,}/, // Google OAuth access tokens
  /\bSK[0-9a-f]{32}\b/, // Twilio API key sids
  /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/, // Resend API keys
  /\bsb_secret_[A-Za-z0-9_-]{10,}/, // Supabase secret keys
  /\bEAA[A-Za-z0-9]{40,}/, // Meta (Facebook/WhatsApp) access tokens
  /\bshpat_[0-9a-f]{32}\b/, // Shopify access tokens
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm tokens
];

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const WEBHOOK = /hooks\.slack\.com\/(?:services|workflows|triggers)\/|discord(?:app)?\.com\/api\/webhooks\/|hooks\.zapier\.com\/hooks\/catch\/|outlook\.office\.com\/webhook\//i;
/** "password: hunter22", "client_secret=xyz…": a password-like label, then ":" or "=", then at least six characters. */
const PASSWORD_ASSIGNMENT = /\b(?:pass(?:word|wd|code)?|pwd|secret|client[_\s-]?secret|private[_\s-]?key)\s*[:=]\s*["']?[^\s"']{6,}/i;
/** "api_key=abc123…", "token: …": key and token labels are common in ordinary text, so the value must be long enough to be a real one. */
const KEY_ASSIGNMENT = /\b(?:api[_\s-]?key|apikey|access[_\s-]?(?:key|token)|auth[_\s-]?token|token|key)\s*[:=]\s*["']?[^\s"']{16,}/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/;
/** Query parameters that carry a credential in a URL. */
const SECRET_PARAMS = new Set(["key", "api_key", "apikey", "access_token", "token", "auth", "auth_token", "secret", "client_secret", "password", "pwd", "sig", "signature", "x-amz-signature", "private_token"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bits of entropy per character: random keys sit near 4.5–6, words and identifiers much lower. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A single run of key-like characters that reads as random: long, mixed letters and digits, and high entropy. */
function looksRandom(word: string): boolean {
  if (word.length < 32 || word.length > 512) return false;
  if (!/^[A-Za-z0-9_+/=.-]+$/.test(word)) return false;
  if (UUID.test(word)) return false;
  if (!/[0-9]/.test(word) || !/[A-Za-z]/.test(word)) return false;
  // Plain hex of 32+ characters (an auth token, a hash) is refused too: no business value is a bare hex string that long.
  if (/^[0-9a-f]+$/i.test(word)) return true;
  return entropy(word) >= 4;
}

function urlFindings(text: string): SecretMatch | null {
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
    let u: URL;
    try {
      u = new URL(m[0]);
    } catch {
      continue;
    }
    if (u.password) return { kind: "url_credentials", label: LABELS.url_credentials };
    for (const [name, value] of u.searchParams) {
      if (SECRET_PARAMS.has(name.toLowerCase()) && value.length >= 8) return { kind: "secret_parameter", label: LABELS.secret_parameter };
    }
  }
  return null;
}

/**
 * Whether a string looks like it contains a credential, and what kind. Null when it doesn't. Applied to whole values, so a key pasted
 * into the middle of a sentence is still found.
 */
export function detectSecret(input: string | null | undefined): SecretMatch | null {
  const text = (input ?? "").trim();
  if (!text) return null;
  const hit = (kind: SecretKind): SecretMatch => ({ kind, label: LABELS[kind] });
  if (PRIVATE_KEY.test(text)) return hit("private_key");
  if (JWT.test(text)) return hit("jwt");
  if (PROVIDER_PATTERNS.some((re) => re.test(text))) return hit("provider_key");
  if (WEBHOOK.test(text)) return hit("webhook_url");
  const url = urlFindings(text);
  if (url) return url;
  if (BEARER.test(text) || PASSWORD_ASSIGNMENT.test(text) || KEY_ASSIGNMENT.test(text)) return hit("secret_assignment");
  // Long random runs, outside web addresses (a long path in a link is not a key; a key in a link's query is caught above).
  const withoutUrls = text.replace(/\bhttps?:\/\/[^\s<>"']+/gi, " ").replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"']*/gi, " ");
  for (const word of withoutUrls.split(/[\s,;:"'()<>[\]{}]+/)) if (looksRandom(word)) return hit("random_token");
  return null;
}

/** Shorthand for a yes/no check. */
export const looksLikeSecret = (input: string | null | undefined): boolean => detectSecret(input) !== null;
