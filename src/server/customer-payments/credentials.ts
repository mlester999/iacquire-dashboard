import "server-only";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";

// The keys of a business's own payment account, which can move money. They are sealed (AES-GCM under APP_ENCRYPTION_KEY, the same format as every other stored
// credential) before they are written, into customer_payment_connections.credentials, a column the application role has no grant on, and opened only inside the
// server for the length of one call. Nothing here is ever returned to a browser, written to a log, an audit row, a notification or an AI prompt.
//
// This file is the seam. Everything that stores or reads a connection's keys goes through `credentialVault`, so moving them to Supabase Vault (what the audit
// recommends, and what migration 0010's rule says for new credentials) changes this file and the sealed column, nothing else.
//
// KNOWN LIMIT, a founder decision pending: a sealed value is tied to APP_ENCRYPTION_KEY and decryptSecret does not try APP_ENCRYPTION_KEY_PREVIOUS, so rotating that key
// makes every stored payment key unreadable (each connection then needs its keys pasted again). That is honest, not silent: opening fails, the connection is marked as
// needing attention, and no payment is started with a key that cannot be read.

export interface ProviderCredentials {
  /** The provider's secret key (PayMongo: sk_test_… or sk_live_…) or, for PayPal, the app's client ID. */
  apiKey: string;
  /** PayPal's client secret. PayMongo has none. */
  apiSecret?: string | null;
  /**
   * What a delivery is checked against. PayMongo: the signing secret of the webhook the owner registered for this connection's address. PayPal: the id of that webhook (a
   * delivery is verified by asking PayPal, with this id). Null until saved: events from the provider are refused until then.
   */
  webhookSecret: string | null;
  /** Provider-specific choices that are not secret: the payment methods to offer (PayMongo), or whether the PayPal app is a sandbox or a live one. */
  settings?: { paymentMethods?: string[]; environment?: "sandbox" | "live" };
}

export interface CredentialVault {
  seal(c: ProviderCredentials): string;
  /** The credentials, or null when there are none or they can no longer be opened. */
  open(sealed: string | null): ProviderCredentials | null;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export const credentialVault: CredentialVault = {
  seal: (c) => encryptSecret(JSON.stringify({ apiKey: c.apiKey, apiSecret: c.apiSecret ?? null, webhookSecret: c.webhookSecret, settings: c.settings ?? {} })),
  open(sealed) {
    if (!sealed) return null;
    try {
      const j = JSON.parse(decryptSecret(sealed)) as { apiKey?: unknown; apiSecret?: unknown; webhookSecret?: unknown; settings?: { paymentMethods?: unknown; environment?: unknown } };
      if (typeof j.apiKey !== "string" || !j.apiKey) return null;
      const methods = j.settings?.paymentMethods;
      const environment = j.settings?.environment === "sandbox" || j.settings?.environment === "live" ? j.settings.environment : undefined;
      const settings = { ...(isStrings(methods) && methods.length ? { paymentMethods: methods } : {}), ...(environment ? { environment } : {}) };
      return {
        apiKey: j.apiKey, apiSecret: typeof j.apiSecret === "string" && j.apiSecret ? j.apiSecret : null, webhookSecret: typeof j.webhookSecret === "string" && j.webhookSecret ? j.webhookSecret : null,
        settings: Object.keys(settings).length ? settings : undefined,
      };
    } catch {
      return null;
    }
  },
};
