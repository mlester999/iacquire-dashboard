/**
 * Browser side of the scoped Supabase Realtime signal for setup screens.
 *
 * The server publishes only a revision number to the private `setup:<organization id>` topic,
 * after the database transaction commits. Row Level Security on `realtime.messages` lets a signed-in
 * user join that topic only while they hold `setup.view` for that organization. This module never
 * decides what a task status is: a revision signal just makes the caller refetch the authorized
 * server snapshot. If Realtime is unavailable the caller's event stream and polling keep working.
 *
 * Everything external is injected so the reconnect, token-refresh and topic-validation rules can be
 * tested without a live Supabase project.
 */

export interface RealtimeGrant {
  url: string;
  publishableKey: string;
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
  channel: string;
}

export type RealtimeState = "connecting" | "subscribed" | "retrying" | "unavailable";

export interface RealtimeChannelLike {
  on(type: "broadcast", filter: { event: string }, callback: (message: { payload?: unknown }) => void): RealtimeChannelLike;
  subscribe(callback: (status: string, error?: Error) => void): RealtimeChannelLike;
}

export interface RealtimeClientLike {
  realtime: { setAuth(token: string): Promise<void> | void };
  channel(name: string, options: { config: { private: boolean } }): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown> | unknown;
}

export interface SetupRealtimeDeps {
  orgId: string;
  /** Resolve a short-lived read-only grant, or null when Realtime is not available for this user/server. */
  fetchGrant(orgId: string): Promise<RealtimeGrant | null>;
  createClient(grant: RealtimeGrant): Promise<RealtimeClientLike>;
  onRevision(revision: number): void;
  onState(state: RealtimeState): void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Renew this long before the access token expires. */
export const TOKEN_RENEW_MARGIN_MS = 60_000;
/** Recheck current membership/assignment at least once a minute, even for hour-long JWTs. */
export const MAX_AUTHORIZATION_RECHECK_MS = 60_000;
const MIN_RENEW_DELAY_MS = 15_000;
const MAX_RETRY_DELAY_MS = 60_000;

/** Only a positive safe integer is a revision. Anything else is ignored, never trusted. */
export function parseRevision(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as { revision?: unknown }).revision;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 2_000 * 2 ** Math.max(0, attempt - 1));
}

/** Starts the subscription and returns a function that stops it and releases the channel. */
export function startSetupRealtime(deps: SetupRealtimeDeps): () => void {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let stopped = false;
  let attempt = 0;
  let retryHandle: unknown;
  let renewHandle: unknown;
  let client: RealtimeClientLike | null = null;
  let channel: RealtimeChannelLike | null = null;
  let generation = 0;

  const state = (s: RealtimeState) => {
    if (!stopped) deps.onState(s);
  };

  async function release() {
    generation += 1;
    clearTimer(renewHandle);
    renewHandle = undefined;
    const current = client;
    const ch = channel;
    client = null;
    channel = null;
    if (current && ch) {
      try {
        await current.removeChannel(ch);
      } catch {
        /* the socket may already be gone */
      }
    }
  }

  function scheduleRetry() {
    if (stopped) return;
    attempt += 1;
    state("retrying");
    clearTimer(retryHandle);
    retryHandle = setTimer(() => void connect(), retryDelayMs(attempt));
  }

  function scheduleRenewal(grant: RealtimeGrant) {
    clearTimer(renewHandle);
    const wait = Math.min(MAX_AUTHORIZATION_RECHECK_MS, Math.max(MIN_RENEW_DELAY_MS, grant.expiresAt * 1000 - now() - TOKEN_RENEW_MARGIN_MS));
    renewHandle = setTimer(() => void renew(), wait);
  }

  async function renew() {
    if (stopped || !client) return;
    const renewingClient = client;
    const renewingGeneration = generation;
    let grant: RealtimeGrant | null = null;
    try {
      grant = await deps.fetchGrant(deps.orgId);
    } catch {
      /* treated like a refused grant below */
    }
    if (stopped || renewingClient !== client || renewingGeneration !== generation) return;
    // Access ended or the server withdrew Realtime: stop quietly. The caller's stream/polling
    // fallback reports a lost session or permission change.
    if (!grant || grant.channel !== `setup:${deps.orgId}`) {
      await release();
      state("unavailable");
      return;
    }
    try {
      await renewingClient.realtime.setAuth(grant.accessToken);
      if (stopped || renewingClient !== client || renewingGeneration !== generation) return;
      scheduleRenewal(grant);
    } catch {
      if (stopped || renewingClient !== client || renewingGeneration !== generation) return;
      await release();
      scheduleRetry();
    }
  }

  async function connect() {
    if (stopped) return;
    state("connecting");
    await release();
    const connectingGeneration = generation;
    try {
      if (!UUID.test(deps.orgId)) {
        state("unavailable");
        return;
      }
      const grant = await deps.fetchGrant(deps.orgId);
      if (stopped || connectingGeneration !== generation) return;
      if (!grant) {
        state("unavailable");
        return;
      }
      // Never join a topic other than the one for the organization this screen is showing.
      if (grant.channel !== `setup:${deps.orgId}`) {
        state("unavailable");
        return;
      }
      const created = await deps.createClient(grant);
      if (stopped || connectingGeneration !== generation) return; // nothing is joined yet
      await created.realtime.setAuth(grant.accessToken);
      if (stopped || connectingGeneration !== generation) return;
      client = created;
      channel = created
        .channel(grant.channel, { config: { private: true } })
        .on("broadcast", { event: "revision" }, (message) => {
          if (stopped || connectingGeneration !== generation) return;
          const revision = parseRevision(message.payload);
          if (revision !== null) deps.onRevision(revision);
        })
        .subscribe((status) => {
          if (stopped || connectingGeneration !== generation) return;
          if (status === "SUBSCRIBED") {
            attempt = 0;
            state("subscribed");
            scheduleRenewal(grant);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            void release().then(scheduleRetry);
          }
        });
    } catch {
      if (stopped || connectingGeneration !== generation) return;
      await release();
      scheduleRetry();
    }
  }

  void connect();

  return () => {
    stopped = true;
    clearTimer(retryHandle);
    void release();
  };
}

/** Real browser wiring: the dynamic import keeps the Supabase client out of pages that never need it. */
export async function fetchRealtimeGrant(orgId: string): Promise<RealtimeGrant | null> {
  try {
    const res = await fetch(`/api/realtime/token?orgId=${encodeURIComponent(orgId)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<RealtimeGrant>;
    if (
      typeof body.url !== "string" || typeof body.publishableKey !== "string" || typeof body.accessToken !== "string" ||
      typeof body.expiresAt !== "number" || typeof body.channel !== "string"
    ) return null;
    return body as RealtimeGrant;
  } catch {
    return null;
  }
}

export async function createBrowserRealtimeClient(grant: RealtimeGrant): Promise<RealtimeClientLike> {
  const { createClient } = await import("@supabase/supabase-js");
  // No session is persisted or refreshed here: the token is a short-lived read-only grant.
  return createClient(grant.url, grant.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) as unknown as RealtimeClientLike;
}
