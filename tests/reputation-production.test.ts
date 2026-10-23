// The simulated review site does not exist in production, whatever else is set: it cannot be connected, read, replied through or believed, so a made-up review can never appear in a
// real workspace. The environment is replaced (NODE_ENV only) around the calls that decide this; the real validation of production configuration is not what is tested here.
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ nodeEnv: "test" as string }));
vi.mock("@/server/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/env")>();
  return { ...actual, env: () => ({ ...actual.env(), NODE_ENV: mode.nodeEnv }) };
});

import { connectSimulatedAccount } from "@/server/social/accounts";
import { connectFacebookPage, connectSimulatedSite, checkConnection, getSites, replyPostable } from "@/server/reputation/connections";
import { reviewProviderFor, simulatedAllowed } from "@/server/reputation/providers";
import { syncConnection } from "@/server/reputation/sync";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { connectSim, count, mirrorCount, reviewsShop, simReview } from "./support/reputation";

afterEach(() => {
  mode.nodeEnv = "test";
});

describe("in production", () => {
  it("has no simulated review site: the registry refuses it, a test connection cannot be made, and the screens do not offer one", async () => {
    const s = await reviewsShop("Production Reviews Shop");
    expect(simulatedAllowed()).toBe(true);
    expect(reviewProviderFor("simulated").adapter).toBe("simulated");
    expect((await getSites(s.owner)).every((x) => x.simulatedAllowed)).toBe(true);
    mode.nodeEnv = "production";
    expect(simulatedAllowed()).toBe(false);
    expect(() => reviewProviderFor("simulated")).toThrow(/not available in production/);
    // The real adapters are still the real adapters: they wait for their own switches, which are off.
    expect(reviewProviderFor("google").adapter).toBe("google");
    expect(reviewProviderFor("meta").adapter).toBe("meta");
    await expect(connectSimulatedSite(s.owner, { provider: "google" })).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/not available here/) });
    const sites = await getSites(s.owner);
    expect(sites.every((x) => !x.simulatedAllowed)).toBe(true);
    expect(sites.every((x) => x.connection === null)).toBe(true);
  });

  it("does not connect a made-up Facebook Page either: a Page that exists only in a test workspace is refused, and nothing is saved", async () => {
    const s = await reviewsShop("Production Page Shop");
    const social = await connectSimulatedAccount(s.m.ctx("owner"), { platform: "facebook", name: "Made-up Page" });
    mode.nodeEnv = "production";
    await expect(connectFacebookPage(s.owner, social.id)).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/not available here/) });
    expect(await count("select count(*)::text as n from review_connections where org_id = $1", [s.m.org.id])).toBe(0);
  });

  it("does not read, check or reply through a test connection that somehow exists, and does not show it as working", async () => {
    simulatedReviews.reset();
    const s = await reviewsShop("Production Stale Shop");
    const c = await connectSim(s, "google", [simReview("p1", { rating: 1 })]);
    mode.nodeEnv = "production";
    expect(await syncConnection(c.id, { now: new Date() })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/isn't available here/) });
    expect(await mirrorCount(c.id)).toBe(0);
    await expect(checkConnection(s.owner, c.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(replyPostable({ adapter: "simulated", provider: "google", status: "connected", can_reply: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/can't post replies here/) });
    const site = (await getSites(s.owner)).find((x) => x.provider === "google");
    expect(site?.state.state).toBe("unavailable");
    expect(site?.state.state).not.toBe("connected");
    expect(simulatedReviews.calls()).toBe(0);
  });
});
