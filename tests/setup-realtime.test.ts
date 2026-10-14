import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRevision,
  retryDelayMs,
  startSetupRealtime,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  type RealtimeGrant,
  type RealtimeState,
} from "@/components/setup/setup-realtime";

// FAKE CLIENT: these tests prove the browser-side rules (topic validation, retry, token renewal,
// cleanup). They do not prove delivery through a live Supabase Realtime service.

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function grant(overrides: Partial<RealtimeGrant> = {}): RealtimeGrant {
  return {
    url: "https://example.supabase.co",
    publishableKey: "sb_publishable_test",
    accessToken: "token-1",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    channel: `setup:${ORG}`,
    ...overrides,
  };
}

class FakeChannel implements RealtimeChannelLike {
  handlers: Array<(m: { payload?: unknown }) => void> = [];
  statusCallback: ((status: string) => void) | null = null;
  on(_type: "broadcast", _filter: { event: string }, callback: (m: { payload?: unknown }) => void) {
    this.handlers.push(callback);
    return this;
  }
  subscribe(callback: (status: string) => void) {
    this.statusCallback = callback;
    return this;
  }
  emit(payload: unknown) {
    this.handlers.forEach((h) => h({ payload }));
  }
  status(s: string) {
    this.statusCallback?.(s);
  }
}

class FakeClient implements RealtimeClientLike {
  channels: Array<{ name: string; options: { config: { private: boolean } }; channel: FakeChannel }> = [];
  removed: FakeChannel[] = [];
  authTokens: string[] = [];
  realtime = { setAuth: async (token: string) => void this.authTokens.push(token) };
  channel(name: string, options: { config: { private: boolean } }) {
    const channel = new FakeChannel();
    this.channels.push({ name, options, channel });
    return channel;
  }
  async removeChannel(channel: RealtimeChannelLike) {
    this.removed.push(channel as FakeChannel);
  }
}

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function harness(opts: { grants?: Array<RealtimeGrant | null>; orgId?: string } = {}) {
  const clients: FakeClient[] = [];
  const grants = [...(opts.grants ?? [grant()])];
  const revisions: number[] = [];
  const states: RealtimeState[] = [];
  const fetchGrant = vi.fn(async () => (grants.length > 1 ? grants.shift()! : (grants[0] ?? null)));
  const stop = startSetupRealtime({
    orgId: opts.orgId ?? ORG,
    fetchGrant,
    createClient: async () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    onRevision: (r) => revisions.push(r),
    onState: (s) => states.push(s),
  });
  return { stop, clients, revisions, states, fetchGrant };
}

describe("Realtime revision parsing", () => {
  it("accepts only positive safe integers and ignores everything else", () => {
    expect(parseRevision({ revision: 7 })).toBe(7);
    for (const bad of [null, undefined, "7", 0, -1, 1.5, Number.NaN, Infinity, 2 ** 60, { revision: "7" }, { revision: null }, []]) {
      expect(parseRevision(bad as unknown)).toBeNull();
    }
  });

  it("backs off exponentially up to a ceiling", () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
  });
});

describe("scoped setup Realtime subscription", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("authenticates, joins only the private topic for this organization, and forwards valid revisions", async () => {
    const h = harness();
    await flush();
    const [client] = h.clients;
    expect(client.authTokens).toEqual(["token-1"]);
    expect(client.channels).toHaveLength(1);
    expect(client.channels[0].name).toBe(`setup:${ORG}`);
    expect(client.channels[0].options).toEqual({ config: { private: true } });

    client.channels[0].channel.status("SUBSCRIBED");
    expect(h.states.at(-1)).toBe("subscribed");

    client.channels[0].channel.emit({ revision: 12 });
    client.channels[0].channel.emit({ revision: "13" });
    client.channels[0].channel.emit({ revision: -4 });
    client.channels[0].channel.emit(null);
    expect(h.revisions).toEqual([12]);
    h.stop();
  });

  it("refuses a grant for a different organization's topic and never subscribes", async () => {
    const h = harness({ grants: [grant({ channel: `setup:${OTHER}` })] });
    await flush();
    expect(h.clients).toHaveLength(0);
    expect(h.states.at(-1)).toBe("unavailable");
    h.stop();
  });

  it("refuses non-UUID scopes without contacting the server", async () => {
    const h = harness({ orgId: "../../admin" });
    await flush();
    expect(h.fetchGrant).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toBe("unavailable");
    h.stop();
  });

  it("reports unavailable (and does not retry) when the server offers no Realtime grant", async () => {
    const h = harness({ grants: [null] });
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.states.at(-1)).toBe("unavailable");
    expect(h.fetchGrant).toHaveBeenCalledTimes(1);
    expect(h.clients).toHaveLength(0);
    h.stop();
  });

  it("releases a failed channel and reconnects with backoff, resetting after success", async () => {
    const h = harness();
    await flush();
    h.clients[0].channels[0].channel.status("CHANNEL_ERROR");
    await flush();
    expect(h.clients[0].removed).toHaveLength(1);
    expect(h.states.at(-1)).toBe("retrying");

    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    await flush();
    expect(h.clients).toHaveLength(2);

    h.clients[1].channels[0].channel.status("SUBSCRIBED");
    h.clients[1].channels[0].channel.status("TIMED_OUT");
    await flush();
    // The attempt counter was reset by the successful join, so the next delay is the shortest again.
    await vi.advanceTimersByTimeAsync(2_001);
    await flush();
    expect(h.clients).toHaveLength(3);
    h.stop();
  });

  it("renews the access token before it expires without rejoining", async () => {
    const soon = Math.floor(Date.now() / 1000) + 120;
    const h = harness({ grants: [grant({ expiresAt: soon, accessToken: "token-1" }), grant({ accessToken: "token-2" })] });
    await flush();
    h.clients[0].channels[0].channel.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(61_000); // 120s - 60s margin
    await flush();
    expect(h.clients[0].authTokens).toEqual(["token-1", "token-2"]);
    expect(h.clients).toHaveLength(1);
    expect(h.states.at(-1)).toBe("subscribed");
    h.stop();
  });

  it("revalidates current access within one minute even when the JWT lasts an hour", async () => {
    const h = harness({ grants: [grant(), null] });
    await flush();
    const original=h.clients[0].channels[0].channel;
    original.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(h.fetchGrant).toHaveBeenCalledTimes(2);
    expect(h.clients[0].removed).toEqual([original]);
    expect(h.states.at(-1)).toBe("unavailable");
    const statesBefore=h.states.length;
    original.emit({revision:99});
    original.status("SUBSCRIBED");
    original.status("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.revisions).toEqual([]);
    expect(h.states).toHaveLength(statesBefore);
    expect(h.clients).toHaveLength(1);
    h.stop();
  });

  it("stops quietly when renewal is refused, leaving the stream and polling fallback in charge", async () => {
    const soon = Math.floor(Date.now() / 1000) + 90;
    const h = harness({ grants: [grant({ expiresAt: soon }), null] });
    await flush();
    h.clients[0].channels[0].channel.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    expect(h.clients[0].removed).toHaveLength(1);
    expect(h.states.at(-1)).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.clients).toHaveLength(1);
    h.stop();
  });

  it("does not restart renewal after the screen closes while token authentication is pending", async () => {
    const h = harness({ grants: [grant(), grant({ accessToken: "token-2" })] });
    await flush();
    const client = h.clients[0];
    client.channels[0].channel.status("SUBSCRIBED");
    let finish: (() => void) | undefined;
    client.realtime.setAuth = async (token: string) => {
      client.authTokens.push(token);
      await new Promise<void>((resolve) => { finish = resolve; });
    };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.authTokens).toEqual(["token-1", "token-2"]);
    h.stop();
    finish?.();
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetchGrant).toHaveBeenCalledTimes(2);
    expect(client.removed).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops cleanly: releases the channel, cancels timers and ignores late events", async () => {
    const h = harness();
    await flush();
    const channel = h.clients[0].channels[0].channel;
    channel.status("SUBSCRIBED");
    h.stop();
    await flush();
    expect(h.clients[0].removed).toEqual([channel]);
    const before = h.states.length;
    channel.emit({ revision: 99 });
    channel.status("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.revisions).toEqual([]);
    expect(h.states).toHaveLength(before);
    expect(h.clients).toHaveLength(1);
  });
});
