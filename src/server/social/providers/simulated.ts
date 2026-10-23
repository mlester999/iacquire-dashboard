import "server-only";
import { ProviderError, type AccountRef, type Credentials, type HealthResult, type Reconciliation, type SocialProvider, type StepResult } from "@/server/social/providers/types";

// A stand-in for a social platform that lives inside this process. It posts nothing anywhere. It exists so the whole publishing pipeline (approval, scheduling,
// retries, duplicate protection, reconciliation, revocation) can be tested and clicked through without a Meta app, and it refuses to run in production.
//
// It behaves the way the real platform is documented to: a text or link post is created unpublished and then published (both steps repeatable), a picture or
// video is sent in one step that is NOT repeatable, and it can be told to fail, to go quiet after doing the work (so the caller never learns the outcome), or to
// have lost its sign-in. Whatever it was asked to do is visible in `world`, which is what the duplicate-protection tests count.

export interface SimPost {
  id: string;
  externalId: string;
  message: string;
  linkUrl: string | null;
  kind: string;
  published: boolean;
  idempotencyKey: string;
  createdAt: Date;
}

type Step = "create" | "publish" | "send" | "reconcile" | "health" | "metrics";

interface World {
  posts: SimPost[];
  seq: number;
  failures: Array<{ step: Step; error: ProviderError }>;
  /** Do the work, then fail with an unknown outcome. */
  lose: Step[];
  revoked: Set<string>;
  metrics: Map<string, Record<string, number>>;
  quota: { usage: number; total: number } | null;
  log: Array<{ step: Step; at: number }>;
}

const fresh = (): World => ({ posts: [], seq: 0, failures: [], lose: [], revoked: new Set(), metrics: new Map(), quota: null, log: [] });
let world: World = fresh();

export const simulated = {
  reset() {
    world = fresh();
  },
  /** Every post the platform now holds for an account, published or not. */
  posts(externalId: string): SimPost[] {
    return world.posts.filter((p) => p.externalId === externalId);
  },
  published(externalId: string): SimPost[] {
    return world.posts.filter((p) => p.externalId === externalId && p.published);
  },
  /** The next time the platform is asked to do this step, it refuses with this error (once). */
  failNext(step: Step, error: ProviderError) {
    world.failures.push({ step, error });
  },
  /** The next time the platform is asked to do this step, it does the work and then never answers. */
  loseResponseNext(step: Step) {
    world.lose.push(step);
  },
  revoke(token: string) {
    world.revoked.add(token);
  },
  setMetrics(providerPostId: string, m: Record<string, number>) {
    world.metrics.set(providerPostId, m);
  },
  setQuota(q: { usage: number; total: number } | null) {
    world.quota = q;
  },
  calls(step?: Step): number {
    return world.log.filter((l) => !step || l.step === step).length;
  },
};

function enter(step: Step) {
  world.log.push({ step, at: Date.now() });
  const i = world.failures.findIndex((f) => f.step === step);
  if (i >= 0) throw world.failures.splice(i, 1)[0].error;
}

/** After the work is done: if the platform was told to go quiet on this step, the caller never learns the outcome. */
function maybeLose(step: Step) {
  const i = world.lose.indexOf(step);
  if (i >= 0) {
    world.lose.splice(i, 1);
    throw new ProviderError("unknown_outcome", "The platform did not confirm whether this post went out. It is being checked and will not be sent again until that is known.");
  }
}

function checkToken(creds: Credentials) {
  if (world.revoked.has(creds.accessToken)) throw new ProviderError("auth", "The platform no longer accepts this account's sign-in. Reconnect the account.", { needsReauth: true });
}

const twoStep = (kind: string) => kind === "text" || kind === "link";

export const simulatedProvider: SocialProvider = {
  adapter: "simulated",

  mayCreate(input, state) {
    // A text or link post is published by its second step; a picture or video is created by its only step.
    return twoStep(input.kind) ? Boolean(state.objectId) : true;
  },

  async health(creds, account: AccountRef): Promise<HealthResult> {
    enter("health");
    const revoked = world.revoked.has(creds.accessToken);
    return {
      status: revoked ? "needs_reauth" : "connected",
      detail: revoked ? "The platform no longer accepts this account's sign-in." : "Connected (simulated).",
      scopes: revoked ? [] : ["simulated.publish"],
      expiresAt: null,
      dataAccessExpiresAt: null,
      capabilities: { contentTypes: account.platform === "instagram" ? ["image", "video"] : ["text", "link", "image", "video"], insights: true },
      quota: account.platform === "instagram" ? world.quota : null,
    };
  },

  async step(creds, input, state): Promise<StepResult> {
    // An answer that was already saved is final: a replayed job must not send again.
    if (state.done && state.providerPostId) return { state };
    checkToken(creds);
    if (twoStep(input.kind)) {
      if (!state.objectId) {
        enter("create");
        // Repeatable: the same publication finds the same unpublished object instead of making another.
        let post = world.posts.find((p) => p.idempotencyKey === input.idempotencyKey);
        if (!post) {
          post = { id: `sim_${++world.seq}`, externalId: input.externalId, message: input.message, linkUrl: input.linkUrl, kind: input.kind, published: false, idempotencyKey: input.idempotencyKey, createdAt: new Date() };
          world.posts.push(post);
        }
        maybeLose("create");
        return { state: { ...state, objectId: post.id } };
      }
      enter("publish");
      const post = world.posts.find((p) => p.id === state.objectId);
      if (!post) throw new ProviderError("invalid_content", "The platform no longer has the post that was prepared.");
      post.published = true;
      maybeLose("publish");
      return { state: { ...state, providerPostId: post.id, permalink: `https://simulated.example/posts/${post.id}`, done: true } };
    }
    enter("send");
    // Not repeatable: sending twice makes two posts. That is exactly what the publisher must never do.
    const post: SimPost = { id: `sim_${++world.seq}`, externalId: input.externalId, message: input.message, linkUrl: input.linkUrl, kind: input.kind, published: true, idempotencyKey: input.idempotencyKey, createdAt: new Date() };
    world.posts.push(post);
    maybeLose("send");
    return { state: { ...state, providerPostId: post.id, permalink: `https://simulated.example/posts/${post.id}`, done: true } };
  },

  async reconcile(creds, input, state): Promise<Reconciliation> {
    checkToken(creds);
    enter("reconcile");
    const post = world.posts.find((p) => p.published && (p.idempotencyKey === input.idempotencyKey || p.id === state.objectId));
    return post ? { found: true, providerPostId: post.id, permalink: `https://simulated.example/posts/${post.id}` } : { found: false };
  },

  async metrics(creds, _account, providerPostId) {
    checkToken(creds);
    enter("metrics");
    return world.metrics.get(providerPostId) ?? {};
  },
};
