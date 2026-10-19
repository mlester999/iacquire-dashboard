import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import type { AqiViewer } from "@/server/aqi/access";
import {
  dismissAqiTip,
  getAqiContextualTip,
  getAqiOnboarding,
  getAqiPreferences,
  recordAqiTipView,
  setAqiOnboardingAction,
  setAqiTipsEnabled,
} from "@/server/aqi/onboarding";

function viewerFor(org: { id: string; name: string }, user: { id: string; email: string }, role: "owner" | "viewer" | "member" = "owner"): AqiViewer {
  const ctx = ctxFor(user, { ...org, slug: "x" }, role);
  return { user: ctx.user, org: { orgId: org.id, name: org.name, kind: "client", role }, permissions: ctx.permissions, can: ctx.can, agencyRole: null };
}

async function fixture(role: "owner" | "viewer" | "member" = "owner") {
  const org = await createOrg({ name: `Onboarding ${Math.random().toString(16).slice(2)}` });
  const user = await createUser();
  await addMember(org.id, user.id, role);
  return { org, user, viewer: viewerFor(org, user, role) };
}

describe("AQi onboarding preferences", () => {
  it("offers the getting-started tour once and remembers every choice", async () => {
    const { viewer } = await fixture("owner");
    const initial = await getAqiOnboarding(viewer, "/overview");
    expect(initial.shouldOffer).toBe(true);
    expect(initial.recommended?.slug).toBe("getting-started");
    expect(initial.preferences.onboardingStatus).toBe("not_seen");

    const dismissed = await setAqiOnboardingAction(viewer, "dismiss");
    expect(dismissed.preferences.onboardingStatus).toBe("dismissed");
    expect((await getAqiOnboarding(viewer, "/overview")).shouldOffer).toBe(false);
    expect((await getAqiOnboarding(viewer, "/overview")).reason).toBe("dismissed");

    await setAqiOnboardingAction(viewer, "reset");
    expect((await getAqiOnboarding(viewer, "/overview")).shouldOffer).toBe(true);
    const deferred = await setAqiOnboardingAction(viewer, "defer");
    expect(deferred.preferences.onboardingStatus).toBe("deferred");
    expect(deferred.preferences.postponedUntil).not.toBeNull();
    expect((await getAqiOnboarding(viewer, "/overview")).shouldOffer).toBe(false);
    expect((await getAqiOnboarding(viewer, "/overview")).reason).toBe("deferred");

    await setAqiOnboardingAction(viewer, "reset");
    const started = await setAqiOnboardingAction(viewer, "start");
    expect(started.tutorialSlug).toBe("getting-started");
    expect(started.preferences.onboardingStatus).toBe("started");
    expect((await getAqiOnboarding(viewer, "/overview")).shouldOffer).toBe(false);

    const prefs = await getAqiPreferences(viewer);
    expect(prefs.onboardingStatus).toBe("started");
    expect(prefs.tipsEnabled).toBe(true);
  });

  it("stays quiet on chat and onboarding routes", async () => {
    const { viewer } = await fixture("owner");
    expect((await getAqiOnboarding(viewer, "/chat/sales-assistant")).shouldOffer).toBe(false);
    expect((await getAqiOnboarding(viewer, "/onboarding")).shouldOffer).toBe(false);
    expect((await getAqiOnboarding(viewer, "/crm/contacts")).shouldOffer).toBe(true);
  });
});

describe("AQi contextual tips", () => {
  it("matches an authorized page and role without calling a model", async () => {
    const { viewer } = await fixture("owner");
    const result = await getAqiContextualTip(viewer, "/crm/contacts");
    expect(result.tipsEnabled).toBe(true);
    expect(result.tip?.slug).toBe("contacts-help");
    expect(result.tip?.tutorialSlug).toBe("create-contact");

    const otherPage = await getAqiContextualTip(viewer, "/billing");
    expect(otherPage.tip).toBeNull();
    expect(otherPage.reason).toBe("no_match");
  });

  it("does not offer a tip whose walkthrough the person cannot use", async () => {
    const { viewer } = await fixture("viewer");
    const result = await getAqiContextualTip(viewer, "/crm/contacts");
    expect(result.tip).toBeNull();
    expect(result.reason).toBe("no_tutorial");
  });

  it("persists a dismissal, can be switched off entirely and deduplicates impressions", async () => {
    const { org, user, viewer } = await fixture("owner");
    await dismissAqiTip(viewer, "contacts-help");
    const afterDismiss = await getAqiContextualTip(viewer, "/crm/contacts");
    expect(afterDismiss.tip).toBeNull();
    expect(afterDismiss.reason).toBe("dismissed");

    await setAqiTipsEnabled(viewer, false);
    const disabled = await getAqiContextualTip(viewer, "/crm/contacts");
    expect(disabled.tip).toBeNull();
    expect(disabled.reason).toBe("disabled");
    await setAqiTipsEnabled(viewer, true);

    await recordAqiTipView(viewer, "contacts-help", "/crm/contacts");
    await recordAqiTipView(viewer, "contacts-help", "/crm/contacts");
    const views = await withSystem(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from aqi_usage_events where org_id = $1 and user_id = $2 and kind = 'tip_view'",
      [org.id, user.id],
    )).rows[0].n);
    expect(views).toBe(1);
  });

  it("returns no tip for a page outside the approved route registry", async () => {
    const { viewer } = await fixture("owner");
    const result = await getAqiContextualTip(viewer, "/completely-unknown-page");
    expect(result.tip).toBeNull();
    expect(result.reason).toBe("no_match");
  });
});
