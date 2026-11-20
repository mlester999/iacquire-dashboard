import { describe, expect, it } from "vitest";
import { buildClientCrmCards, buildOAuthCalendarCard, buildSlackWebhookCard, type ClientCrmFacts } from "@/lib/integrations/client-tools";

function facts(patch: Partial<ClientCrmFacts> = {}): ClientCrmFacts {
  return {
    mode: "native",
    owners: { crm: "native", calendars: "native" },
    counts: {
      contacts: 3,
      pipelines: 1,
      activeCalendars: 1,
      connectedCalendars: 0,
      enabledChannels: 0,
      testedChannels: 0,
      activeWorkflows: 0,
    },
    ghl: { locationName: null, mappingStatus: null, verifiedAt: null, crmCheck: null, calendarCheck: null },
    ...patch,
  };
}

describe("client integration cards", () => {
  it("shows iAcquire CRM and Calendar first for a native workspace, and no GoHighLevel card", () => {
    const cards = buildClientCrmCards(facts());
    expect(cards.map((card) => card.key)).toEqual(["native_crm", "native_calendar"]);
    expect(cards[0]).toMatchObject({ name: "iAcquire CRM", statusLabel: "Active", check: "Built into iAcquire", fact: "3 contacts · 1 pipeline" });
    expect(cards[0].status?.status).toBe("connected");
    expect(cards[1]).toMatchObject({ name: "iAcquire Calendar", statusLabel: "Active", fact: "1 active calendar" });
    expect(cards.some((card) => card.key.startsWith("ghl"))).toBe(false);
  });

  it("keeps a GoHighLevel workspace's real cards and does not add native ones", () => {
    const cards = buildClientCrmCards(facts({
      mode: "ghl",
      owners: { crm: "ghl", calendars: "ghl" },
      ghl: {
        locationName: "Cedar Valley",
        mappingStatus: "connected",
        verifiedAt: "2026-10-19T00:00:00.000Z",
        crmCheck: { provider: "ghl", status: "connected", detail: null, last_checked_at: "2026-10-19T01:00:00.000Z" },
        calendarCheck: { provider: "ghl_calendar", status: "connected", detail: null, last_checked_at: null },
      },
    }));
    expect(cards.map((card) => card.key)).toEqual(["ghl_crm", "ghl_calendar"]);
    expect(cards[0]).toMatchObject({ name: "GoHighLevel CRM", fact: "Cedar Valley", statusLabel: "Connected", check: "Service check passed" });
    expect(cards[1]).toMatchObject({ name: "GoHighLevel Calendar", statusLabel: "Connected" });
  });

  it("mixes native and GoHighLevel only for the capabilities each owns in a hybrid", () => {
    const cards = buildClientCrmCards(facts({
      mode: "hybrid",
      owners: { crm: "native", calendars: "ghl" },
      ghl: { locationName: null, mappingStatus: "pending", verifiedAt: null, crmCheck: null, calendarCheck: null },
    }));
    expect(cards.map((card) => card.key)).toEqual(["native_crm", "ghl_calendar"]);
    // A mapped-but-unverified location is never reported as connected.
    expect(cards[1].status?.status).toBe("pending");
    expect(cards[1].statusLabel).toBe("Not verified");
  });

  it("shows a recorded GoHighLevel check even when the workspace looks native, so existing configurations are not hidden", () => {
    const cards = buildClientCrmCards(facts({
      ghl: {
        locationName: null,
        mappingStatus: null,
        verifiedAt: null,
        crmCheck: { provider: "ghl", status: "error", detail: "Token refused", last_checked_at: null },
        calendarCheck: null,
      },
    }));
    expect(cards.map((card) => card.key)).toEqual(["native_crm", "native_calendar", "ghl_crm"]);
    expect(cards[2]).toMatchObject({ check: "Managed by iAcquire" });
    expect(cards[2].status?.status).toBe("error");
    expect(cards[2].statusLabel).toBe("Error");
  });

  it("does not overstate an empty native workspace", () => {
    const cards = buildClientCrmCards(facts({
      counts: { contacts: 0, pipelines: 0, activeCalendars: 0, connectedCalendars: 0, enabledChannels: 0, testedChannels: 0, activeWorkflows: 0 },
    }));
    expect(cards.map((card) => card.key)).toEqual(["native_crm", "native_calendar"]);
    expect(cards[0]).toMatchObject({ fact: "Ready for your first contact" });
    expect(cards[1]).toMatchObject({ statusLabel: "Not set up" });
    expect(cards[1].status?.status).toBe("not_configured");
  });

  it("treats a mapped location without a verified check as pending, never connected", () => {
    const cards = buildClientCrmCards(facts({
      mode: "ghl",
      owners: { crm: "ghl", calendars: "ghl" },
      ghl: { locationName: "Mapped but unverified", mappingStatus: "connected", verifiedAt: null, crmCheck: null, calendarCheck: null },
    }));
    expect(cards.map((card) => card.key)).toEqual(["ghl_crm", "ghl_calendar"]);
    expect(cards[0].status?.status).toBe("pending");
    expect(cards[0].statusLabel).toBe("Not verified");
    expect(cards[1].status?.status).toBe("pending");
  });
});

describe("external connection cards", () => {
  const google = { key: "google", label: "Google Calendar", configured: true } as const;
  const outlook = { key: "microsoft", label: "Microsoft Outlook / 365", configured: true } as const;
  const checkedAt = "2026-11-19T00:00:00.000Z";

  it("distinguishes missing provider configuration and user permission from an available OAuth connection", () => {
    const missing = buildOAuthCalendarCard({ ...google, configured: false }, [], true, false);
    expect(missing).toMatchObject({ statusLabel: "Requires setup", link: { href: "/crm/calendar-connections" } });
    expect(missing.status).toBeUndefined();
    expect(buildOAuthCalendarCard(google, [], false, false).statusLabel).toBe("Requires authorization");
    expect(buildOAuthCalendarCard(google, [], true, false).statusLabel).toBe("Available");
  });

  it("shows verification only for the matching provider and reports when sync or authorization needs attention", () => {
    const connections = [
      { provider: "google", status: "connected", lastSuccessAt: checkedAt },
      { provider: "microsoft", status: "needs_reauth", lastSuccessAt: null },
    ] as const;
    expect(buildOAuthCalendarCard(google, connections, true, true)).toMatchObject({
      statusLabel: "Connected",
      status: { status: "connected", last_checked_at: checkedAt },
      body: expect.stringContaining("sync is currently paused"),
    });
    expect(buildOAuthCalendarCard(outlook, connections, true, false)).toMatchObject({
      statusLabel: "Needs authorization",
      status: { status: "degraded" },
    });
    expect(buildOAuthCalendarCard({ ...google, configured: false }, connections, true, false).statusLabel).toBe("Requires setup");
  });

  it("shows Slack status as unavailable when the read fails, without a setup link", () => {
    const card = buildSlackWebhookCard(null, []);
    expect(card.statusLabel).toBe("Status unavailable");
    expect(card.link).toBeUndefined();
    expect(card.status).toBeUndefined();
  });

  it("requires both the managed plan and a verified Slack webhook for the connected state", () => {
    const verified = { kind: "slack_webhook", status: "active", verifiedAt: checkedAt } as const;
    const lapsed = buildSlackWebhookCard(false, [verified]);
    expect(lapsed.statusLabel).toBe("Requires managed plan");
    expect(lapsed.link).toBeUndefined();
    expect(buildSlackWebhookCard(true, [{ ...verified, kind: "http" }]).statusLabel).toBe("Available");
    expect(buildSlackWebhookCard(true, [{ ...verified, verifiedAt: null }]).statusLabel).toBe("Needs verification");
    expect(buildSlackWebhookCard(true, [verified])).toMatchObject({
      statusLabel: "Verified webhook",
      status: { status: "connected", last_checked_at: checkedAt },
      link: { href: "/automation-studio/connections" },
    });
  });
});
