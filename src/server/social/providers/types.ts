import type { FailureKind } from "@/lib/social/errors";
import type { Platform, PostKind } from "@/lib/social/rules";

// The contract between the publisher and a social platform. The publisher knows nothing about Facebook or Instagram: it persists a small `PublishState`
// after every step, so a worker that dies and a worker that takes over both continue from the same place, and it asks the adapter to `reconcile` when an
// answer never arrived, so a post is never sent twice by guesswork.

export class ProviderError extends Error {
  readonly kind: FailureKind;
  readonly needsReauth: boolean;
  readonly retryAfterSec: number | null;
  readonly httpStatus: number | null;
  constructor(kind: FailureKind, message: string, opts: { needsReauth?: boolean; retryAfterSec?: number | null; httpStatus?: number | null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.needsReauth = opts.needsReauth ?? false;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.httpStatus = opts.httpStatus ?? null;
  }
}

/** A connected account's decrypted credentials. Held in memory only for the length of a call. */
export interface Credentials {
  accessToken: string;
}

export interface AccountRef {
  platform: Platform;
  externalId: string;
}

export interface AccountCapabilities {
  contentTypes: PostKind[];
  insights: boolean;
}

export interface HealthResult {
  status: "connected" | "needs_reauth" | "error";
  detail: string;
  scopes: string[];
  expiresAt: Date | null;
  dataAccessExpiresAt: Date | null;
  capabilities: AccountCapabilities;
  /** What the provider said about its posting limits, when it said: { quotaUsage, quotaTotal }. */
  quota: { usage: number; total: number } | null;
}

export interface PublishInput {
  platform: Platform;
  externalId: string;
  kind: PostKind;
  /** The text to post, hashtags included. */
  message: string;
  linkUrl: string | null;
  /** Addresses the platform can fetch the media from (short-lived signed addresses for managed files). */
  media: Array<{ kind: "image" | "video"; url: string; mimeType: string }>;
  /** Stable per publication. Adapters that can pass one to the provider do; the rest rely on the persisted state and on `reconcile`. */
  idempotencyKey: string;
}

/**
 * What has already happened at the provider for one publication. Saved after every step. `sendingAt` is written BEFORE a request that could create the
 * post leaves, so a crash in between is recognised as "possibly sent" and checked, never repeated.
 */
export interface PublishState {
  /** An unpublished object created on the platform (Facebook text or link post), published by a second, repeatable step. */
  objectId?: string;
  /** An Instagram media container, and whether the platform has finished processing it. */
  creationId?: string;
  ready?: boolean;
  sendingAt?: string;
  providerPostId?: string;
  permalink?: string | null;
  done?: boolean;
}

export interface StepResult {
  state: PublishState;
  /** When the provider is not ready yet (a video still processing), seconds to wait before the next step. */
  waitSeconds?: number;
}

export interface Reconciliation {
  found: boolean;
  providerPostId?: string;
  permalink?: string | null;
}

export interface SocialProvider {
  readonly adapter: "meta" | "simulated";
  /** Whether the NEXT step could create something visible at the platform. The publisher records the intent to send before such a step, so a crash is never mistaken for "not sent". */
  mayCreate(input: PublishInput, state: PublishState): boolean;
  health(creds: Credentials, account: AccountRef): Promise<HealthResult>;
  /** Performs the next step of the publication and returns the state after it. Throws ProviderError. */
  step(creds: Credentials, input: PublishInput, state: PublishState): Promise<StepResult>;
  /** Asks the platform whether this publication exists. Used only when an answer was lost. */
  reconcile(creds: Credentials, input: PublishInput, state: PublishState, since: Date): Promise<Reconciliation>;
  /** The numbers the provider returns for a published post. Only what it returned. */
  metrics(creds: Credentials, account: AccountRef, providerPostId: string): Promise<Record<string, number>>;
}
