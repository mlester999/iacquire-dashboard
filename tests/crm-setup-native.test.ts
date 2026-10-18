// Phase 6, package C: a native CRM client can complete the Setup Center on evidence, a GoHighLevel client keeps its flow, and the client's
// CRM setup guide shows honest statuses from real rows, autosaves and resumes at the exact step. Synthetic data only; no provider is called
// (channel capability tests use an injected tester, calendar connections are recorded rows).
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ actor: null as null | import("@/server/crm/actor").CrmActor }));
// The actions resolve their actor from the session; here the test chooses who is acting, and the permission check still runs.
vi.mock("@/server/crm/request", async () => {
  const { assertCan } = await import("@/server/crm/actor");
  return {
    resolveCrmActor: async (_orgId: string | null, permission: import("@/lib/permissions").Permission) => {
      if (!who.actor) throw new Error("No actor chosen for this test.");
      assertCan(who.actor, permission);
      return who.actor;
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// The guide is rendered to HTML below without a running app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/crm/setup",
  useSearchParams: () => new URLSearchParams(),
}));

import { withSystem, withUser } from "@/server/db";
import { scopeFor } from "@/server/crm/page";
import { CrmSetupGuide } from "@/components/setup/crm-setup-guide";
import { chooseInitialCrmProviderAction, recheckCrmSetupAction, requestCrmSetupReviewAction, saveCrmSetupGuideAction } from "@/app/actions/crm-setup";
import { ensureInstanceStandalone, getSetupRevision } from "@/server/setup/core";
import { activateSetup, markReadyForReview, setServices, updateTaskStatus } from "@/server/setup/agency";
import { attestTask, runChecks, verifyTask } from "@/server/setup/automation";
import { getAgencySetupSnapshot, getClientSetupSnapshot } from "@/server/setup/snapshots";
import { executePreparation, queuePreparation } from "@/server/setup/jobs";
import { CONNECTORS, connectorsFor } from "@/server/setup/connectors";
import { chooseInitialCrmProvider, getCrmSetupGuide, recheckCrmSetup, requestCrmSetupReview, saveCrmSetupGuide } from "@/server/setup/crm-guide";
import { getOnboardingReview } from "@/server/onboarding/service";
import { applyBlueprint, previewApplication } from "@/server/crm/blueprints/apply";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { createContact } from "@/server/crm/contacts";
import { configureNativeChannel, enableChannel, runChannelCapabilityTest } from "@/server/messaging/channels";
import { getBlueprintChecklistForOrg } from "@/server/crm/blueprints/checklist";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { hostResolver } from "@/server/calendars/adapters/http";
import { connectIcsFeed, updateConnectionOptions } from "@/server/calendars/connections";
import { syncConnectionBusy } from "@/server/calendars/sync";
import type { CapabilityTest } from "@/server/messaging/transports/types";
import { applicableSteps, buildCrmSetupSteps, resolveGuideStep, type CrmSetupStep, type CrmSetupStepKey } from "@/lib/onboarding/crm-setup";
import { createGuideAutosave, type GuidePatch, type GuideSaveResult } from "@/lib/onboarding/crm-setup-autosave";
import { ctxFor } from "./support/fixtures";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { confirmation, field, insertPublishedBlueprint, smallContent } from "./support/blueprints";
import { createTag } from "@/server/crm/tags";

type Agency = Awaited<ReturnType<typeof agencyPeople>>;
let agency: Agency;
beforeAll(async () => {
  agency = await agencyPeople();
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const task = async (orgId: string, key: string) =>
  (await q<{ id: string; status: string; service_excluded: boolean; required: boolean; crm_provider: string | null; completion_source: string | null; title: string }>(
    "select id, status, service_excluded, required, crm_provider, completion_source, title from client_setup_tasks where org_id = $1 and template_key = $2",
    [orgId, key],
  ))[0];
const check = async (orgId: string, key: string) => (await q<{ status: string; detail: string }>("select status, detail from client_setup_checks where org_id = $1 and check_key = $2", [orgId, key]))[0];

async function client(opts: { services?: string[]; mode?: "native" | "ghl" } = {}): Promise<CrmOrg> {
  const c = await crmOrg();
  if (opts.mode === "ghl") await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
  await ensureInstanceStandalone(c.org.id);
  await setServices(agency.superAdmin, c.org.id, opts.services ?? ["crm"]);
  return c;
}

async function finishOnboarding(orgId: string) {
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = now() where id = $1", [orgId]);
    await db.query("insert into onboarding_responses (org_id, current_step, completed_at) values ($1, 5, now()) on conflict (org_id) do update set completed_at = now()", [orgId]);
  });
}

/** Publishes `content` and applies it the way the agency does: a preview, then the apply with that preview's plan digest. */
async function applyContent(orgId: string, content: ReturnType<typeof smallContent>) {
  const bp = await insertPublishedBlueprint(content);
  const options = { strategy: "add_missing" as const };
  const preview = await previewApplication(agency.superAdmin, orgId, { blueprintId: bp.blueprintId, version: bp.version, options });
  const result = await applyBlueprint(agency.superAdmin, orgId, { blueprintId: bp.blueprintId, version: bp.version, options, planDigest: preview.plan.digest, idempotencyKey: confirmation() });
  return { bp, result };
}

/** Applies the small sample Blueprint (one pipeline with four stages, two tags, a field, a value, a template and a draft workflow). */
const applySample = (orgId: string) => applyContent(orgId, smallContent());

/** A native email sender (Resend) with credentials saved and no test run yet. */
async function resendEmail(orgId: string) {
  await configureNativeChannel(agency.superAdmin, orgId, {
    channel: "email", provider: "resend", secret: `re_${crypto.randomBytes(16).toString("hex")}`,
    senderIdentity: `Sample Clinic <hello-${crypto.randomBytes(3).toString("hex")}@example.test>`, senderId: crypto.randomUUID(), replaceLiveChannel: true,
  });
}

/** A native client brought to readiness on evidence: onboarding, the sample Blueprint, the agency's two manual preparation steps. */
async function nativeReady(orgId: string) {
  await finishOnboarding(orgId);
  await applySample(orgId);
  await runChecks(orgId, { actorUserId: null, live: false });
  for (const key of ["crm_tags", "lead_forms"]) await updateTaskStatus(agency.superAdmin, orgId, (await task(orgId, key)).id, { status: "completed", evidenceUrl: "https://example.com/setup-evidence" });
  await runChecks(orgId, { actorUserId: null, live: false });
}

const passing = async (): Promise<CapabilityTest> => ({ ok: true, checkedAt: new Date().toISOString(), checks: [{ label: "Account", ok: true, detail: "The account is active." }], registrationStatus: "approved" });
const failing = async (): Promise<CapabilityTest> => ({ ok: false, checkedAt: new Date().toISOString(), checks: [{ label: "Account", ok: false, detail: "Twilio refused the auth token." }] });

async function twilioSms(orgId: string) {
  const accountId = `AC${crypto.randomBytes(16).toString("hex")}`;
  await configureNativeChannel(agency.superAdmin, orgId, {
    channel: "sms", provider: "twilio", secret: { accountSid: accountId, authToken: crypto.randomBytes(16).toString("hex") },
    senderIdentity: `+1512555${String(Math.floor(Math.random() * 9000) + 1000)}`, senderId: `MG${crypto.randomBytes(16).toString("hex")}`, accountId, replaceLiveChannel: true,
  });
}

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
/** An active, public iAcquire calendar whose host has weekly hours: a customer could book it. */
async function bookableCalendar(c: CrmOrg) {
  const owner = c.actor("owner");
  await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: `Consults ${crypto.randomUUID().slice(0, 6)}`, assignment: "single", public: true, members: [{ userId: c.people.owner.id }] });
  await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, locationKind: "phone", meetingProvider: "none" });
  return cal.id;
}

const stepOf = (steps: CrmSetupStep[], key: CrmSetupStepKey) => steps.find((s) => s.key === key);
const statusOf = async (c: CrmOrg, key: CrmSetupStepKey, who: Parameters<CrmOrg["actor"]>[0] = "owner") => {
  const g = await getCrmSetupGuide(c.actor(who));
  return stepOf(buildCrmSetupSteps(g.facts, g.answers), key)?.status;
};

// ---------------------------------------------------------------------------
// Setup Center
// ---------------------------------------------------------------------------

describe("a native CRM client in the Setup Center", () => {
  it("never gets the GoHighLevel location step, and gets the optional native sender steps", async () => {
    const c = await client();
    expect(await task(c.org.id, "ghl_subaccount")).toMatchObject({ crm_provider: "ghl", service_excluded: true });
    for (const key of ["sms_sender", "whatsapp_sender"]) expect(await task(c.org.id, key)).toMatchObject({ crm_provider: "native", service_excluded: false, required: false });
    expect((await task(c.org.id, "crm_snapshot")).title).toBe("CRM Blueprint applied");
    // The native connectors apply.
    const registry = await withSystem((db) => connectorsFor(db, c.org.id));
    expect(registry.crm_snapshot).toBe(CONNECTORS.crm_snapshot);
    expect(registry.crm_snapshot.implemented && registry.crm_assets.implemented && registry.calendar.implemented).toBe(true);
  });

  it("shows the sender steps only to clients with the CRM service", async () => {
    const site = await client({ services: ["website"] });
    const senders = await Promise.all(["sms_sender", "whatsapp_sender"].map((k) => task(site.org.id, k)));
    for (const s of senders) expect(s).toMatchObject({ service_excluded: true, crm_provider: "native" });
    const snap = await getClientSetupSnapshot(ctxFor(site.people.owner, site.org, "owner"));
    const ids = new Set(snap!.tasks.map((t) => t.id));
    expect(senders.some((s) => ids.has(s.id))).toBe(false);
    // Adding the CRM service brings them back.
    await setServices(agency.superAdmin, site.org.id, ["website", "crm"]);
    for (const k of ["sms_sender", "whatsapp_sender"]) expect((await task(site.org.id, k)).service_excluded).toBe(false);
  });

  it("reaches activation on evidence alone: onboarding, an applied Blueprint and a matching manifest", async () => {
    const c = await client({ services: ["crm"] });
    const admin = agency.superAdmin;
    await runChecks(c.org.id, { actorUserId: admin.id, live: false, force: true });
    expect(await check(c.org.id, "crm_snapshot")).toMatchObject({ status: "unverified", detail: expect.stringMatching(/No CRM Blueprint/) });
    expect(await check(c.org.id, "crm_assets")).toMatchObject({ status: "unverified", detail: expect.stringMatching(/No expected manifest/) });
    await expect(markReadyForReview(admin, c.org.id)).rejects.toThrow(/Not ready/);

    await finishOnboarding(c.org.id);
    await applySample(c.org.id);
    await runChecks(c.org.id, { actorUserId: null, live: false });
    // No GoHighLevel prerequisite holds the Blueprint step back any more.
    expect(await task(c.org.id, "crm_snapshot")).toMatchObject({ status: "completed", completion_source: "connector" });
    expect(await check(c.org.id, "crm_assets")).toMatchObject({ status: "verified", detail: expect.stringMatching(/Expected 1 pipeline, 4 stages, 2 tags, 1 custom field and 0 forms/) });
    // crm_assets still waits for the agency's two preparation steps.
    expect((await task(c.org.id, "crm_assets")).status).toBe("pending");
    for (const key of ["crm_tags", "lead_forms"]) await updateTaskStatus(admin, c.org.id, (await task(c.org.id, key)).id, { status: "completed", evidenceUrl: "https://example.com/setup-evidence" });
    await runChecks(c.org.id, { actorUserId: null, live: false });
    expect(await task(c.org.id, "crm_assets")).toMatchObject({ status: "completed", completion_source: "connector" });
    // Optional sender steps ran (unverified) but don't hold the final system check back.
    expect(await check(c.org.id, "sms_sender")).toMatchObject({ status: "unverified" });
    expect(await task(c.org.id, "integration_tests")).toMatchObject({ status: "completed", completion_source: "connector" });

    const snap = await getAgencySetupSnapshot(admin, c.org.id);
    expect(snap.progress.percent).toBe(100);
    expect(snap.checks.find((k) => k.key === "crm_snapshot")).toMatchObject({ label: "CRM Blueprint applied", status: "verified", connectorImplemented: true });
    expect(snap.tasks.find((t) => t.templateKey === "ghl_subaccount")).toMatchObject({ serviceExcluded: true, crmProvider: "ghl" });

    await markReadyForReview(admin, c.org.id);
    await activateSetup(admin, c.org.id, { note: "Native CRM verified on evidence." });
    expect((await getAgencySetupSnapshot(admin, c.org.id)).state).toBe("activated");
    expect(await q("select decision from activation_reviews where org_id = $1", [c.org.id])).toEqual([{ decision: "approved" }]);
  });

  it("lets a failing optional sender through 'Verify configured integrations' (reported, not failed), but not a failing required check", async () => {
    const admin = agency.superAdmin;
    const verifyJob = async (orgId: string) => {
      const id = await queuePreparation(admin, orgId, { operation: "verify_integrations", idempotencyKey: `verify:${crypto.randomUUID()}` });
      const out = await executePreparation(admin, orgId, String(id));
      const row = (await q<{ status: string; last_error: string | null; prepared_configuration: { optionalFailures?: string[] } | null }>(
        "select status, last_error, prepared_configuration from provisioning_jobs where id = $1", [id]))[0];
      return { out, row };
    };

    const c = await client({ services: ["crm"] });
    await nativeReady(c.org.id);
    await twilioSms(c.org.id);
    await runChannelCapabilityTest(admin, c.org.id, "sms", { test: failing });
    await runChecks(c.org.id, { actorUserId: null, live: false });
    expect(await check(c.org.id, "sms_sender")).toMatchObject({ status: "failed" });
    expect(await check(c.org.id, "final_health")).toMatchObject({ status: "verified" });
    const ok = await verifyJob(c.org.id);
    expect(ok.out).toMatchObject({ status: "succeeded" });
    expect(ok.row).toMatchObject({ status: "succeeded", prepared_configuration: { optionalFailures: ["sms_sender"] }, last_error: expect.stringMatching(/Every required check is verified\. Optional checks that need attention: SMS sender/) });
    await markReadyForReview(admin, c.org.id);
    await activateSetup(admin, c.org.id, { note: "Required checks verified; the optional SMS sender is being fixed separately." });
    expect((await getAgencySetupSnapshot(admin, c.org.id)).state).toBe("activated");

    // A failing required check still fails the job, and says which one.
    const d = await client({ services: ["crm"] });
    await nativeReady(d.org.id);
    await withSystem((db) => db.query("delete from crm_tags where org_id = $1 and name = 'VIP'", [d.org.id]));
    const bad = await verifyJob(d.org.id);
    expect(bad.row).toMatchObject({ status: "failed", last_error: expect.stringMatching(/^A required integration check failed: .*CRM/) });
  });

  it("fails the Blueprint and manifest checks when applied records are deleted or archived, and reopens nothing silently", async () => {
    const c = await client();
    await finishOnboarding(c.org.id);
    await applySample(c.org.id);
    await runChecks(c.org.id, { actorUserId: null, live: false });
    expect((await check(c.org.id, "crm_snapshot")).status).toBe("verified");
    await withSystem((db) => db.query("delete from crm_tags where org_id = $1 and name = 'VIP'", [c.org.id]));
    await withSystem((db) => db.query("update crm_pipeline_stages set archived_at = now() where org_id = $1 and name = 'Quoted'", [c.org.id]));
    await runChecks(c.org.id, { actorUserId: null, live: false });
    const snapshot = await check(c.org.id, "crm_snapshot");
    expect(snapshot.status).toBe("failed");
    expect(snapshot.detail).toMatch(/tag “VIP” \(deleted\)/);
    expect(snapshot.detail).toMatch(/stage “Quoted” \(archived\)/);
    expect((await check(c.org.id, "crm_assets")).status).toBe("failed");
    // A failing check can't be covered by agency evidence, and a native check can't be attested at all.
    await expect(attestTask(agency.superAdmin, c.org.id, (await task(c.org.id, "crm_snapshot")).id, { note: "Looked at it in the CRM and it seems fine." })).rejects.toThrow(/failed provider check/);
    await expect(attestTask(agency.superAdmin, c.org.id, (await task(c.org.id, "crm_assets")).id, { note: "Looked at it in the CRM and it seems fine." })).rejects.toThrow(/failed provider check/);
    // The client is told something needs attention, without the technical detail.
    const notes = await q<{ body: string }>("select body from notifications where user_id = $1 and kind = 'setup_issue'", [c.people.owner.id]);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => !/VIP|Quoted/.test(n.body))).toBe(true);
  });

  it("verifies the calendar only on a real open time, and fails it when a connected calendar needs signing in again", async () => {
    const c = await client({ services: ["crm", "calendar"] });
    await runChecks(c.org.id, { actorUserId: null, live: false, keys: ["calendar"] });
    expect(await check(c.org.id, "calendar")).toMatchObject({ status: "unverified", detail: expect.stringMatching(/No calendar/) });
    await bookableCalendar(c);
    await runChecks(c.org.id, { actorUserId: null, live: false, keys: ["calendar"] });
    expect(await check(c.org.id, "calendar")).toMatchObject({ status: "verified", detail: expect.stringMatching(/calendar-only setup/) });
    await withSystem((db) => db.query("insert into crm_calendar_connections (org_id, user_id, provider, account_label, status) values ($1, $2, 'google', 'owner@example.test', 'needs_reauth')", [c.org.id, c.people.owner.id]));
    await runChecks(c.org.id, { actorUserId: null, live: false, keys: ["calendar"] });
    expect(await check(c.org.id, "calendar")).toMatchObject({ status: "failed", detail: expect.stringMatching(/needs signing in again/) });
  });

  describe("a connected calendar counts only after a successful read of its busy times (real connect and sync paths)", () => {
    // The feed is served by a stubbed fetch: "ok" returns a small calendar, "503" an outage. No real network.
    let feed: "ok" | "503" = "ok";
    const ICS = ["BEGIN:VCALENDAR", "X-WR-CALNAME:Owner personal", "BEGIN:VEVENT", "UID:busy-1", "DTSTART:20261020T060000Z", "DTEND:20261020T070000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    beforeEach(() => {
      feed = "ok";
      vi.spyOn(hostResolver, "lookup").mockImplementation(async () => ["93.184.216.34"]);
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        feed === "503" ? new Response("Service unavailable", { status: 503 }) : new Response(ICS, { status: 200, headers: { "content-type": "text/calendar" } }));
    });
    afterEach(() => vi.restoreAllMocks());
    const connection = async (id: string) =>
      (await q<{ status: string; check_conflicts: boolean; last_synced_at: Date | null; last_success_at: Date | null }>("select status, check_conflicts, last_synced_at, last_success_at from crm_calendar_connections where id = $1", [id]))[0];
    const feedUrl = () => `https://feeds.example.com/${crypto.randomUUID()}.ics`;
    const calendarCheck = async (orgId: string) => {
      await runChecks(orgId, { actorUserId: null, live: false, keys: ["calendar"] });
      return check(orgId, "calendar");
    };

    it("a failed sync attempt is not a sync: unverified, not completed, not Verified in the guide, until a sync succeeds", async () => {
      const c = await client({ services: ["crm", "calendar"] });
      const owner = c.actor("owner");
      await saveCrmSetupGuide(owner, { answers: { appointments: true, calendarSource: "ics" } });
      await bookableCalendar(c);
      const conn = await connectIcsFeed(owner, { url: feedUrl() });
      feed = "503";
      expect((await syncConnectionBusy(conn.id, { force: true })).status).toBe("failed");
      // What sync.ts leaves after a non-auth failure: still connected, an attempt time, no success.
      expect(await connection(conn.id)).toMatchObject({ status: "connected", last_synced_at: expect.any(Date), last_success_at: null });
      expect(await calendarCheck(c.org.id)).toMatchObject({ status: "unverified", detail: expect.stringMatching(/no fresh successful sync.*no successful sync yet/) });
      expect(await task(c.org.id, "calendar")).toMatchObject({ completion_source: null });
      expect((await task(c.org.id, "calendar")).status).not.toBe("completed");
      const g = await getCrmSetupGuide(owner);
      expect(stepOf(buildCrmSetupSteps(g.facts, g.answers), "calendar")).toMatchObject({ status: "in_progress", summary: expect.stringMatching(/Waiting for the first successful sync/) });

      // A later successful read verifies all three.
      feed = "ok";
      expect(["ok", "unchanged"]).toContain((await syncConnectionBusy(conn.id, { force: true })).status);
      expect((await connection(conn.id)).last_success_at).toBeInstanceOf(Date);
      expect(await calendarCheck(c.org.id)).toMatchObject({ status: "verified", detail: expect.stringMatching(/1 connected calendar read busy times successfully/) });
      expect(await task(c.org.id, "calendar")).toMatchObject({ status: "completed", completion_source: "connector" });
      expect(await statusOf(c, "calendar")).toBe("verified");
    });

    it("a connection with conflict checking off reads nothing: it never verifies a stated outside calendar, and never blocks a calendar-only setup", async () => {
      const c = await client({ services: ["crm", "calendar"] });
      const owner = c.actor("owner");
      await saveCrmSetupGuide(owner, { answers: { appointments: true, calendarSource: "ics" } });
      await bookableCalendar(c);
      const conn = await connectIcsFeed(owner, { url: feedUrl() });
      await updateConnectionOptions(owner, conn.id, { checkConflicts: false });
      // The no-busy-check sync only touches last_synced_at.
      expect((await syncConnectionBusy(conn.id, { force: true })).status).toBe("ok");
      expect(await connection(conn.id)).toMatchObject({ status: "connected", check_conflicts: false, last_synced_at: expect.any(Date), last_success_at: null });
      expect(await calendarCheck(c.org.id)).toMatchObject({ status: "unverified", detail: expect.stringMatching(/connected but conflict checking is off, so busy times from it aren't read/) });
      expect((await task(c.org.id, "calendar")).status).not.toBe("completed");
      const g = await getCrmSetupGuide(owner);
      expect(stepOf(buildCrmSetupSteps(g.facts, g.answers), "calendar")).toMatchObject({
        status: "needs_client_action", summary: expect.stringMatching(/conflict checking is off, so busy times aren't read/), next: expect.stringMatching(/Turn it on in Calendar Connections/),
      });

      // Turning conflict checking back on and syncing successfully verifies it.
      await updateConnectionOptions(owner, conn.id, { checkConflicts: true });
      await syncConnectionBusy(conn.id, { force: true });
      expect(await calendarCheck(c.org.id)).toMatchObject({ status: "verified", detail: expect.stringMatching(/1 connected calendar read busy times successfully/) });
      expect(await statusOf(c, "calendar")).toBe("verified");

      // Off again, with the client now on the iAcquire calendar only: the write-only connection doesn't hold the calendar-only setup back,
      // and it isn't counted as a synced calendar either.
      const other = await client({ services: ["crm", "calendar"] });
      await saveCrmSetupGuide(other.actor("owner"), { answers: { appointments: true, calendarSource: "iacquire" } });
      await bookableCalendar(other);
      const off = await connectIcsFeed(other.actor("owner"), { url: feedUrl() });
      await updateConnectionOptions(other.actor("owner"), off.id, { checkConflicts: false });
      expect(await calendarCheck(other.org.id)).toMatchObject({ status: "verified", detail: expect.stringMatching(/calendar-only setup: the client chose the iAcquire calendar\); 1 connected calendar with conflict checking off/) });
    });
  });

  it("verifies a sender only after a passed live test, never because credentials were saved, and fails it on a failed test", async () => {
    const c = await client();
    await twilioSms(c.org.id);
    await runChecks(c.org.id, { actorUserId: null, live: false, keys: ["sms_sender"] });
    expect(await check(c.org.id, "sms_sender")).toMatchObject({ status: "unverified", detail: expect.stringMatching(/Credentials are saved/) });
    await runChannelCapabilityTest(agency.superAdmin, c.org.id, "sms", { test: passing });
    await runChecks(c.org.id, { actorUserId: null, live: false, keys: ["sms_sender"] });
    expect(await check(c.org.id, "sms_sender")).toMatchObject({ status: "verified" });
    expect(await task(c.org.id, "sms_sender")).toMatchObject({ status: "completed", completion_source: "connector" });
    await runChannelCapabilityTest(agency.superAdmin, c.org.id, "sms", { test: failing });
    await runChecks(c.org.id, { actorUserId: null, live: false, keys: ["sms_sender"] });
    expect(await check(c.org.id, "sms_sender")).toMatchObject({ status: "failed", detail: expect.stringMatching(/refused the auth token/) });
  });
});

describe("a GoHighLevel client keeps the GoHighLevel flow", () => {
  it("keeps the location step and its dependants, with the GoHighLevel checks that can't verify", async () => {
    const c = await client({ mode: "ghl", services: ["crm", "calendar", "email"] });
    expect(await task(c.org.id, "ghl_subaccount")).toMatchObject({ service_excluded: false });
    // A GoHighLevel client created after 0037 gets the GoHighLevel title, like the existing ones.
    expect((await task(c.org.id, "crm_snapshot")).title).toBe("CRM snapshot installed");
    for (const key of ["sms_sender", "whatsapp_sender"]) expect((await task(c.org.id, key)).service_excluded).toBe(true);
    const registry = await withSystem((db) => connectorsFor(db, c.org.id));
    for (const key of ["crm_snapshot", "crm_assets", "calendar", "email_domain"] as const) expect(registry[key].implemented).toBe(false);
    await finishOnboarding(c.org.id);
    await runChecks(c.org.id, { actorUserId: null, live: false });
    const snapshotTask = await task(c.org.id, "crm_snapshot");
    await expect(verifyTask(agency.superAdmin, c.org.id, snapshotTask.id)).rejects.toThrow(/Record an agency attestation/);
    await expect(attestTask(agency.superAdmin, c.org.id, snapshotTask.id, { note: "Snapshot installed; checked in GoHighLevel." })).rejects.toThrow(/Finish "GHL sub-account created" first/);
    await expect(attestTask(agency.superAdmin, c.org.id, (await task(c.org.id, "calendar")).id, { note: "Calendar authorized; checked in GoHighLevel." })).rejects.toThrow(/Finish "GHL sub-account created" first/);
    // GoHighLevel workspaces keep their step titles.
    const snap = await getAgencySetupSnapshot(agency.superAdmin, c.org.id);
    expect(snap.checks.find((k) => k.key === "crm_snapshot")).toMatchObject({ label: "CRM snapshot (GoHighLevel)", connectorImplemented: false });
  });

  it("attestation never completes a verified step", async () => {
    const c = await client({ mode: "ghl", services: ["email"] });
    await finishOnboarding(c.org.id);
    await runChecks(c.org.id, { actorUserId: null, live: false });
    const email = await task(c.org.id, "email_domain");
    await attestTask(agency.superAdmin, c.org.id, email.id, { note: "DNS records checked at the registrar; SPF and DKIM present." });
    expect(await task(c.org.id, "email_domain")).toMatchObject({ status: "ready_for_review", completion_source: null });
    expect((await check(c.org.id, "email_domain")).status).toBe("attested");
    await runChecks(c.org.id, { actorUserId: agency.superAdmin.id, live: true, force: true });
    expect((await task(c.org.id, "email_domain")).status).toBe("ready_for_review");
    await expect(updateTaskStatus(agency.superAdmin, c.org.id, email.id, { status: "completed" })).rejects.toThrow(/system check/);
    await expect(withSystem((db) => db.query("update client_setup_tasks set status = 'completed', completed_at = now(), completion_source = 'attestation' where id = $1", [email.id]))).rejects.toThrow(/check constraint/i);
  });

  it("follows a provider change in the same transaction: steps appear or disappear and the revision moves", async () => {
    const c = await client({ services: ["crm"] });
    const before = (await getSetupRevision(c.org.id))!;
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
    expect((await task(c.org.id, "ghl_subaccount")).service_excluded).toBe(false);
    expect((await task(c.org.id, "sms_sender")).service_excluded).toBe(true);
    expect((await task(c.org.id, "crm_snapshot")).title).toBe("CRM snapshot installed");
    expect((await getSetupRevision(c.org.id))!).toBeGreaterThan(before);
    // Hybrid uses both providers. Pipelines stay native here, so the snapshot step is the Blueprint step again.
    await withSystem(async (db) => {
      await db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [c.org.id]);
      await db.query("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'calendars', 'ghl')", [c.org.id]);
    });
    expect((await task(c.org.id, "ghl_subaccount")).service_excluded).toBe(false);
    expect((await task(c.org.id, "sms_sender")).service_excluded).toBe(false);
    expect((await task(c.org.id, "crm_snapshot")).title).toBe("CRM Blueprint applied");
    const registry = await withSystem((db) => connectorsFor(db, c.org.id));
    expect(registry.calendar.implemented).toBe(false);
    expect(registry.crm_snapshot.implemented).toBe(true);
    // Pipelines on GoHighLevel: its title, and its (unimplemented) check.
    await withSystem((db) => db.query("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'pipelines', 'ghl')", [c.org.id]));
    expect((await task(c.org.id, "crm_snapshot")).title).toBe("CRM snapshot installed");
    expect((await withSystem((db) => connectorsFor(db, c.org.id))).crm_snapshot.implemented).toBe(false);
    await withSystem(async (db) => {
      await db.query("delete from crm_capability_providers where org_id = $1", [c.org.id]);
      await db.query("update crm_workspaces set mode = 'native' where org_id = $1", [c.org.id]);
    });
    expect((await task(c.org.id, "ghl_subaccount")).service_excluded).toBe(true);
    expect((await task(c.org.id, "crm_snapshot")).title).toBe("CRM Blueprint applied");
    // A title the agency chose is never swapped.
    await withSystem((db) => db.query("update client_setup_tasks set title = 'Install the dental CRM template' where org_id = $1 and template_key = 'crm_snapshot'", [c.org.id]));
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
    expect((await task(c.org.id, "crm_snapshot")).title).toBe("Install the dental CRM template");
    const events = await q<{ metadata: { reason?: string } }>("select metadata from client_setup_task_events where org_id = $1 and event = 'services_changed'", [c.org.id]);
    expect(events.some((e) => e.metadata.reason === "crm_provider")).toBe(true);
  });
});

describe("migration 0037 over existing checklists", () => {
  class Done extends Error {}
  /** Splits a script into statements, keeping `$$ ... $$` bodies whole (as tests/crm-migrations.test.ts does). */
  const statements = (sql: string) => {
    const out: string[] = [];
    let cur: string[] = [];
    let inside = false;
    for (const raw of sql.split("\n")) {
      const line = raw.replace("\r", "");
      if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
      cur.push(line);
      if (line.split("$$").length % 2 === 0) inside = !inside;
      if (!inside && line.trimEnd().endsWith(";")) {
        out.push(cur.join("\n"));
        cur = [];
      }
    }
    return out;
  };

  it("records the in-flight GoHighLevel sub-account work it sets aside for a workspace 0027 made native, and keeps it", async () => {
    const nativeBusy = await client({ services: ["crm", "calendar"] });
    const nativeIdle = await client({ services: ["crm", "calendar"] });
    const ghlBusy = await client({ mode: "ghl", services: ["crm", "calendar"] });
    const ids = [nativeBusy.org.id, nativeIdle.org.id, ghlBusy.org.id];
    const up = readFileSync("supabase/migrations/0056_crm_setup_native.sql", "utf8");
    const down = readFileSync("supabase/rollbacks/0056_crm_setup_native.down.sql", "utf8");
    let report: { events: Array<{ org_id: string; task_id: string | null; reason: string; metadata: Record<string, unknown> }>; tasks: Array<Record<string, unknown>> } | null = null;
    // Always rolled back: the shared test database is untouched.
    await expect(withSystem(async (db) => {
      // What the rollback refuses to drop (guide progress, sender steps with checks from earlier tests) is cleared inside this transaction.
      await db.query("delete from crm_setup_guides");
      await db.query("delete from client_setup_checks where check_key in ('sms_sender', 'whatsapp_sender')");
      await db.query("delete from client_setup_tasks where template_key in ('sms_sender', 'whatsapp_sender')");
      for (const s of statements(down)) await db.query(s);
      // Before 0037: every client had the GoHighLevel step. Two of them already had progress on it.
      for (const org of [nativeBusy.org.id, ghlBusy.org.id]) {
        await db.query("update client_setup_tasks set status = 'in_progress', client_note = 'Waiting for the location to be created.' where org_id = $1 and template_key = 'ghl_subaccount'", [org]);
      }
      for (const s of statements(up)) await db.query(s);
      report = {
        events: (await db.query<{ org_id: string; task_id: string | null; reason: string; metadata: Record<string, unknown> }>(
          "select org_id, task_id, reason, metadata from client_setup_task_events where org_id = any($1::uuid[]) and event = 'services_changed' and metadata->>'migration' = '0037'", [ids],
        )).rows,
        tasks: (await db.query(
          `select t.org_id, t.template_key, t.title, t.status, t.client_note, t.service_excluded, t.service, t.id from client_setup_tasks t
           where t.org_id = any($1::uuid[]) and t.template_key in ('ghl_subaccount', 'crm_snapshot', 'sms_sender') order by t.org_id, t.template_key`, [ids],
        )).rows,
      };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    const r = report!;
    const t = (org: string, key: string) => r.tasks.find((x) => x.org_id === org && x.template_key === key)!;
    // Exactly one record: the native workspace whose GoHighLevel step had progress.
    expect(r.events).toEqual([{
      org_id: nativeBusy.org.id, task_id: t(nativeBusy.org.id, "ghl_subaccount").id, reason: expect.stringMatching(/no longer applies.*Its progress is kept.*choose GoHighLevel in the CRM setup guide/),
      metadata: { reason: "crm_provider", migration: "0037", template_key: "ghl_subaccount", status: "in_progress" },
    }]);
    // Excluded, but its progress and note are kept.
    expect(t(nativeBusy.org.id, "ghl_subaccount")).toMatchObject({ status: "in_progress", client_note: "Waiting for the location to be created.", service_excluded: true });
    expect(t(nativeIdle.org.id, "ghl_subaccount")).toMatchObject({ status: "pending", service_excluded: true });
    expect(t(ghlBusy.org.id, "ghl_subaccount")).toMatchObject({ status: "in_progress", service_excluded: false });
    // Titles follow the pipelines owner; the sender steps are scoped to the CRM service.
    expect(t(ghlBusy.org.id, "crm_snapshot").title).toBe("CRM snapshot installed");
    expect(t(nativeBusy.org.id, "crm_snapshot").title).toBe("CRM Blueprint applied");
    expect(t(nativeBusy.org.id, "sms_sender")).toMatchObject({ service: "crm", service_excluded: false });
  });
});

// ---------------------------------------------------------------------------
// The client's CRM setup guide
// ---------------------------------------------------------------------------

describe("CRM setup guide statuses come from real rows", () => {
  it("starts honest, moves with evidence, and shows Failed after a failed capability test", async () => {
    const c = await client({ services: ["crm", "calendar"] });
    let g = await getCrmSetupGuide(c.actor("owner"));
    let steps = buildCrmSetupSteps(g.facts, g.answers);
    expect(steps.map((s) => s.key)).toEqual(["provider", "blueprint", "fields", "pipelines", "tags", "calendar", "scheduling", "communications", "workflows", "ai_roles", "verify", "review"]);
    expect(Object.fromEntries(steps.map((s) => [s.key, s.status]))).toMatchObject({
      provider: "configured", blueprint: "needs_agency_action", fields: "not_started", pipelines: "not_started", tags: "not_started", calendar: "not_started",
      scheduling: "not_started", communications: "not_started", workflows: "not_started", review: "needs_agency_action",
    });
    expect(steps.some((s) => s.status === "verified")).toBe(false);

    await applySample(c.org.id);
    g = await getCrmSetupGuide(c.actor("owner"));
    steps = buildCrmSetupSteps(g.facts, g.answers);
    // The sample Blueprint is applied and intact, but its own setup checklist still has required items open (an email sender, template
    // approval), so the Blueprint step isn't Verified yet; its records match, so the data steps are.
    expect(Object.fromEntries(steps.map((s) => [s.key, s.status]))).toMatchObject({ blueprint: "needs_client_action", fields: "verified", pipelines: "verified", tags: "verified", workflows: "needs_client_action" });

    // Saving a sender's credentials is never "verified".
    await saveCrmSetupGuide(c.actor("owner"), { answers: { channels: ["sms"] } });
    await twilioSms(c.org.id);
    expect(await statusOf(c, "communications")).toBe("in_progress");
    await runChannelCapabilityTest(agency.superAdmin, c.org.id, "sms", { test: failing });
    expect(await statusOf(c, "communications")).toBe("failed");
    await runChannelCapabilityTest(agency.superAdmin, c.org.id, "sms", { test: passing });
    // Passed its live test, but sending is still off: set up, not yet in use (the Blueprint checklist's rule too).
    expect(await statusOf(c, "communications")).toBe("configured");
    await enableChannel(agency.superAdmin, c.org.id, "sms");
    expect(await statusOf(c, "communications")).toBe("verified");

    // Calendar: the answer adapts the guide, the evidence sets the status.
    await saveCrmSetupGuide(c.actor("owner"), { answers: { appointments: true, calendarSource: "google" } });
    expect(await statusOf(c, "calendar")).toBe("needs_client_action");
    await withSystem((db) => db.query("insert into crm_calendar_connections (org_id, user_id, provider, account_label, status) values ($1, $2, 'google', 'owner@example.test', 'error')", [c.org.id, c.people.owner.id]));
    expect(await statusOf(c, "calendar")).toBe("failed");
    await withSystem((db) => db.query("update crm_calendar_connections set status = 'connected', last_success_at = now() where org_id = $1", [c.org.id]));
    expect(await statusOf(c, "calendar")).toBe("verified");
    expect(await statusOf(c, "scheduling")).toBe("not_started");
    await bookableCalendar(c);
    expect(await statusOf(c, "scheduling")).toBe("verified");

    // A Blueprint record removed: the guide says so.
    await withSystem((db) => db.query("delete from crm_tags where org_id = $1 and name = 'Hot lead'", [c.org.id]));
    g = await getCrmSetupGuide(c.actor("owner"));
    steps = buildCrmSetupSteps(g.facts, g.answers);
    expect(stepOf(steps, "blueprint")?.status).toBe("failed");
    expect(stepOf(steps, "tags")?.status).toBe("failed");
    // Client-safe: no record names from the agency detail.
    expect(stepOf(steps, "blueprint")?.summary).not.toMatch(/Hot lead/);

    // Verify integrations follows the Setup Center's checks. Those already ran when the Blueprint was applied and the sender was tested
    // (the Setup Center picks that evidence up at once, package L C2), so the step is under way rather than not started; the deleted tag
    // is seen at the next run, which fails it.
    expect(stepOf(steps, "verify")?.status).toBe("in_progress");
    await recheckCrmSetup(c.actor("owner"));
    expect(await statusOf(c, "verify")).toBe("failed");
  });

  it("agrees with the Blueprint's own setup checklist: Verified only with nothing required open, and a channel counts only with sending on", async () => {
    const c = await client({ services: ["crm"] });
    const owner = c.actor("owner");
    await applySample(c.org.id);
    const open = (await getBlueprintChecklistForOrg(c.org.id)).items.filter((i) => i.required && i.status === "pending");
    expect(open.map((i) => i.key)).toEqual(expect.arrayContaining(["email_provider", "template_approval"]));
    const blueprint = async () => {
      const g = await getCrmSetupGuide(owner);
      return stepOf(buildCrmSetupSteps(g.facts, g.answers), "blueprint")!;
    };
    let bp = await blueprint();
    expect(bp).toMatchObject({ status: "needs_client_action", next: "Finish them in Blueprints & setup." });
    expect(bp.summary).toContain(`${open.length} setup items it needs are still open`);
    for (const i of open.slice(0, 3)) expect(bp.summary).toContain(i.label);

    // Email passed its live test with sending off: pending on the checklist, Configured in the guide. Switching it on makes both done.
    await saveCrmSetupGuide(owner, { answers: { channels: ["email"] } });
    await resendEmail(c.org.id);
    await runChannelCapabilityTest(agency.superAdmin, c.org.id, "email", { test: passing });
    const emailItem = async () => (await getBlueprintChecklistForOrg(c.org.id)).items.find((i) => i.key === "email_provider")!;
    expect((await emailItem()).status).toBe("pending");
    expect(await statusOf(c, "communications")).toBe("configured");
    await enableChannel(agency.superAdmin, c.org.id, "email");
    expect((await emailItem()).status).toBe("done");
    expect(await statusOf(c, "communications")).toBe("verified");
    bp = await blueprint();
    expect(bp.status).toBe("needs_client_action");
    expect(bp.summary).not.toContain("Connect an email sender");
    expect(bp.summary).toContain("Approve message wording");

    // A Blueprint that asks for nothing more: applied, intact and nothing open, so Verified.
    const plain = await client({ services: ["crm"] });
    const content = smallContent("plain-sample");
    content.assets.messageTemplates = [];
    content.assets.workflows = [];
    await applyContent(plain.org.id, content);
    expect((await getBlueprintChecklistForOrg(plain.org.id)).items.filter((i) => i.required && i.status === "pending")).toEqual([]);
    expect(await statusOf(plain, "blueprint")).toBe("verified");
  });

  it("says 'matching your Blueprint' only for the kinds of records the Blueprint actually had", async () => {
    const dataSteps = async (c: CrmOrg) => {
      const g = await getCrmSetupGuide(c.actor("owner"));
      const steps = buildCrmSetupSteps(g.facts, g.answers);
      return { fields: stepOf(steps, "fields")!, pipelines: stepOf(steps, "pipelines")!, tags: stepOf(steps, "tags")! };
    };
    const handField = (orgId: string) => q("insert into crm_custom_fields (org_id, entity, key, label, type) values ($1, 'contact', 'hand_made', 'Hand made', 'text')", [orgId]);

    // No custom fields in the Blueprint; one contact field made by hand.
    const noFields = await client();
    const a = smallContent("no-fields");
    a.assets.customFields = [];
    a.assets.workflows = [];
    await applyContent(noFields.org.id, a);
    await handField(noFields.org.id);
    let s = await dataSteps(noFields);
    expect(s.fields).toMatchObject({ status: "configured", summary: "1 contact field." });
    // The pipeline it did have still matches.
    expect(s.pipelines).toMatchObject({ status: "verified", summary: expect.stringMatching(/matching your Blueprint/) });

    // No tags in the Blueprint; one tag made by hand.
    const noTags = await client();
    const b = smallContent("no-tags");
    b.assets.tags = [];
    b.assets.workflows = [];
    await applyContent(noTags.org.id, b);
    await createTag(noTags.actor("owner"), { name: "Made by hand" });
    s = await dataSteps(noTags);
    expect(s.tags).toMatchObject({ status: "configured", summary: "1 tag." });
    expect(s.fields).toMatchObject({ status: "verified", summary: expect.stringMatching(/matching your Blueprint/) });

    // Only an opportunity field in the Blueprint: nothing about contact fields was checked.
    const oppOnly = await client();
    const o = smallContent("opportunity-field");
    o.assets.customFields = [field("field.opportunity.budget", "opportunity", "budget", "Budget", "number")];
    o.assets.workflows = [];
    await applyContent(oppOnly.org.id, o);
    await handField(oppOnly.org.id);
    s = await dataSteps(oppOnly);
    expect(s.fields.status).toBe("configured");
    expect(s.fields.summary).not.toMatch(/matching your Blueprint/);
  });

  it("skips scheduling when the business doesn't take appointments, and hides capabilities GoHighLevel owns", async () => {
    const c = await client();
    await saveCrmSetupGuide(c.actor("owner"), { answers: { appointments: false } });
    let g = await getCrmSetupGuide(c.actor("owner"));
    expect(applicableSteps(g.facts, g.answers)).not.toContain("scheduling");
    expect(stepOf(buildCrmSetupSteps(g.facts, g.answers), "calendar")?.status).toBe("configured");
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
    g = await getCrmSetupGuide(c.actor("owner"));
    expect(applicableSteps(g.facts, g.answers)).toEqual(["provider", "ai_roles", "verify", "review"]);
    expect(stepOf(buildCrmSetupSteps(g.facts, g.answers), "provider")).toMatchObject({ status: "needs_agency_action", summary: expect.stringMatching(/connect your GoHighLevel location/) });
  });

  it("uses onboarding answers until the guide's own question is answered", async () => {
    const c = await client();
    await withSystem((db) => db.query(
      "insert into onboarding_answers (org_id, question_id, value, source) values ($1, 'b.appointments', 'true'::jsonb, 'user'), ($1, 'c.channels', '[\"email\", \"whatsapp\"]'::jsonb, 'user')",
      [c.org.id],
    ));
    const g = await getCrmSetupGuide(c.actor("owner"));
    expect(g.facts.prefill).toEqual({ appointments: true, channels: ["email", "whatsapp"] });
    expect(stepOf(buildCrmSetupSteps(g.facts, g.answers), "communications")?.status).toBe("needs_agency_action");
  });
});

describe("CRM setup guide: autosave and exact-step resume", () => {
  it("resumes at the exact step with the saved answers, and moves on when that step stops applying", async () => {
    const c = await client({ services: ["crm", "calendar"] });
    const owner = c.actor("owner");
    expect((await getCrmSetupGuide(owner)).currentStep).toBe("provider");
    const first = await saveCrmSetupGuide(owner, { currentStep: "communications", answers: { channels: ["email"] }, baseRevision: 0 });
    expect(first).toMatchObject({ revision: 1, currentStep: "communications", staleBase: false });
    let g = await getCrmSetupGuide(owner);
    expect(g).toMatchObject({ currentStep: "communications", revision: 1, answers: { channels: ["email"] } });
    // Answering one question never clears another.
    await saveCrmSetupGuide(owner, { currentStep: "scheduling", answers: { appointments: true }, baseRevision: 1 });
    g = await getCrmSetupGuide(owner);
    expect(g).toMatchObject({ currentStep: "scheduling", answers: { channels: ["email"], appointments: true } });
    // The person said "no appointments" on another tab: scheduling no longer applies, so the guide resumes at the next step that does.
    const stale = await saveCrmSetupGuide(owner, { answers: { appointments: false }, baseRevision: 1 });
    expect(stale.staleBase).toBe(true);
    g = await getCrmSetupGuide(owner);
    expect(g.currentStep).toBe("communications");
    expect(resolveGuideStep("nonsense", ["provider", "verify"])).toBe("provider");
    await expect(saveCrmSetupGuide(owner, { currentStep: "nope" as CrmSetupStepKey })).rejects.toThrow();
    await expect(saveCrmSetupGuide(owner, { answers: { channels: ["fax" as "sms"] } })).rejects.toThrow();
  });

  // The screen's save queue (src/lib/onboarding/crm-setup-autosave.ts, used by crm-setup-guide.tsx).
  it("runs the screen's saves one at a time, each with the revision the previous save or guide action returned", async () => {
    const calls: Array<{ body: GuidePatch & { baseRevision: number }; resolve: (r: GuideSaveResult) => void }> = [];
    const states: string[] = [];
    const errors: string[] = [];
    const saver = createGuideAutosave({
      revision: 4,
      save: (body) => new Promise((resolve) => calls.push({ body, resolve })),
      onState: (s) => states.push(s),
      onError: (m) => errors.push(m),
    });
    saver.queue({ currentStep: "blueprint" }, 0);
    const first = saver.flush();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // "Next" again while the first save is still running: the second save waits, then sends the first save's revision.
    saver.queue({ currentStep: "fields" }, 0);
    const second = saver.flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    calls[0].resolve({ ok: true, revision: 5, staleBase: false });
    await first;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => [c.body.currentStep, c.body.baseRevision])).toEqual([["blueprint", 4], ["fields", 5]]);
    calls[1].resolve({ ok: true, revision: 6, staleBase: false });
    await second;
    // A guide action (the provider choice) runs after the pending save and its revision is adopted for the next save.
    saver.queue({ answers: { appointments: true } }, 400);
    const chosen = saver.action(async () => ({ ok: true as const, data: { revision: 9 } }), (r) => (r.ok ? r.data.revision : null));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].body).toEqual({ answers: { appointments: true }, baseRevision: 6 });
    calls[2].resolve({ ok: true, revision: 7, staleBase: false });
    await chosen;
    expect(saver.revision).toBe(9);
    // A late, older revision never moves the queue backwards.
    await saver.action(async () => 3, (r) => r);
    expect(saver.revision).toBe(9);
    // A failed save keeps what wasn't saved for the retry, merged under anything newer.
    saver.queue({ answers: { channels: ["email"] } }, 0);
    const failed = saver.flush();
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3].body.baseRevision).toBe(9);
    saver.queue({ currentStep: "tags" }, 10_000);
    calls[3].resolve({ ok: false, error: "Couldn't save." });
    await failed;
    expect(errors).toEqual(["Couldn't save."]);
    expect(saver.pending()).toEqual({ currentStep: "tags", answers: { channels: ["email"] } });
    expect(states.at(-1)).toBe("error");
    const retry = saver.flush();
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    calls[4].resolve({ ok: true, revision: 10, staleBase: false });
    await retry;
    expect(saver.pending()).toEqual({});
  });

  it("with the real service, the guide's own provider choice, review hand-off and quick saves never read as another tab's change", async () => {
    const c = await client({ services: ["crm"] });
    const owner = c.actor("owner");
    let stale = 0;
    const started: number[] = [];
    const saver = createGuideAutosave({
      revision: (await getCrmSetupGuide(owner)).revision,
      save: async (body) => {
        started.push(body.baseRevision);
        const r = await saveCrmSetupGuide(owner, body);
        return { ok: true, revision: r.revision, staleBase: r.staleBase };
      },
      onStale: () => { stale += 1; },
    });
    expect(saver.revision).toBe(0);
    // "Confirm this choice", then "Next" twice in quick succession.
    await saver.action(() => chooseInitialCrmProvider(owner, "native"), (r) => r.revision);
    saver.queue({ currentStep: "blueprint" }, 0);
    const a = saver.flush();
    await vi.waitFor(() => expect(started.length).toBeGreaterThan(0));
    saver.queue({ currentStep: "fields" }, 0);
    await Promise.all([a, saver.flush()]);
    // "Tell iAcquire we're ready", then move on.
    await saver.action(() => requestCrmSetupReview(owner), (r) => r.revision);
    saver.queue({ currentStep: "review" }, 0);
    await saver.flush();
    expect(stale).toBe(0);
    expect((await getCrmSetupGuide(owner)).currentStep).toBe("review");
    // A real change from another tab is still reported.
    await saveCrmSetupGuide(owner, { currentStep: "tags" });
    saver.queue({ currentStep: "workflows" }, 0);
    await saver.flush();
    expect(stale).toBe(1);
  });
});

describe("CRM setup guide: who may do what", () => {
  it("lets owners and admins edit and everyone else view", async () => {
    const c = await client();
    for (const who of ["owner", "manager"] as const) {
      expect((await getCrmSetupGuide(c.actor(who))).canEdit).toBe(true);
      await saveCrmSetupGuide(c.actor(who), { currentStep: "tags" });
    }
    for (const who of ["sales", "setter", "support", "viewer"] as const) {
      const g = await getCrmSetupGuide(c.actor(who));
      expect(g).toMatchObject({ canEdit: false, canChooseProvider: false, canRequestReview: false, currentStep: "tags" });
      await expect(saveCrmSetupGuide(c.actor(who), { currentStep: "provider" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(recheckCrmSetup(c.actor(who))).rejects.toMatchObject({ code: "forbidden" });
      await expect(requestCrmSetupReview(c.actor(who))).rejects.toMatchObject({ code: "forbidden" });
      await expect(chooseInitialCrmProvider(c.actor(who), "ghl")).rejects.toMatchObject({ code: "forbidden" });
    }
    // Only the owner chooses the provider.
    expect((await getCrmSetupGuide(c.actor("manager"))).canChooseProvider).toBe(false);
    await expect(chooseInitialCrmProvider(c.actor("manager"), "ghl")).rejects.toMatchObject({ code: "forbidden" });
    expect((await getCrmSetupGuide(c.actor("owner"))).canChooseProvider).toBe(true);
  });

  it("gives an agency read session a view and a super admin's write session the edits, never the client's hand-off", async () => {
    const c = await client();
    await startSupportSession(agency.superAdmin, c.org.id, { mode: "read", reason: "Reviewing the CRM setup guide" });
    const reader = await agencyActor(agency.superAdmin, c.org.id);
    expect((await getCrmSetupGuide(reader)).canEdit).toBe(false);
    await expect(saveCrmSetupGuide(reader, { currentStep: "tags" })).rejects.toMatchObject({ code: "forbidden" });
    await startSupportSession(agency.superAdmin, c.org.id, { mode: "write", reason: "Helping the owner finish the CRM setup guide" });
    const writer = await agencyActor(agency.superAdmin, c.org.id);
    expect(writer.supportMode).toBe("write");
    await saveCrmSetupGuide(writer, { currentStep: "pipelines" });
    expect((await getCrmSetupGuide(c.actor("owner"))).currentStep).toBe("pipelines");
    await expect(requestCrmSetupReview(writer)).rejects.toMatchObject({ code: "forbidden" });
    await chooseInitialCrmProvider(writer, "native");
    const audit = await q<{ actor_kind: string }>("select actor_kind from audit_logs where org_id = $1 and action = 'crm.provider_initial_choice'", [c.org.id]);
    expect(audit).toEqual([{ actor_kind: "agency" }]);
  });

  it("allows the initial provider choice only while there is nothing to migrate", async () => {
    const c = await client({ services: ["crm"] });
    const owner = c.actor("owner");
    // The returned revision is the stored one and moves by one per choice: the screen sends it as its next autosave's baseRevision.
    const first = await chooseInitialCrmProvider(owner, "ghl");
    expect(first).toEqual({ mode: "ghl", changed: true, revision: expect.any(Number) });
    expect(await q("select revision from crm_setup_guides where org_id = $1", [c.org.id])).toEqual([{ revision: first.revision }]);
    // The Setup Center followed the choice.
    expect((await task(c.org.id, "ghl_subaccount")).service_excluded).toBe(false);
    const second = await chooseInitialCrmProvider(owner, "native");
    expect(second).toEqual({ mode: "native", changed: true, revision: first.revision + 1 });
    expect((await saveCrmSetupGuide(owner, { currentStep: "blueprint", baseRevision: second.revision })).staleBase).toBe(false);
    expect((await task(c.org.id, "ghl_subaccount")).service_excluded).toBe(true);
    await createContact(owner, { firstName: "Real", lastName: "Record" });
    await expect(chooseInitialCrmProvider(owner, "ghl")).rejects.toThrow(/already has CRM records/);
    const g = await getCrmSetupGuide(owner);
    expect(g).toMatchObject({ canChooseProvider: false, facts: { provider: { canChoose: false, lockedReason: expect.stringMatching(/CRM Provider/) } } });
    expect(await q("select mode from crm_workspaces where org_id = $1", [c.org.id])).toEqual([{ mode: "native" }]);
  });

  it("hands off to the agency without activating anything", async () => {
    const c = await client();
    const out = await requestCrmSetupReview(c.actor("owner"));
    expect(out.notified).toBe(true);
    expect((await requestCrmSetupReview(c.actor("manager"))).notified).toBe(false);
    const n = await q("select 1 from notifications where user_id = $1 and title like $2", [agency.superAdmin.id, `${c.org.name}: CRM setup is ready for review`]);
    expect(n).toHaveLength(1);
    expect((await getAgencySetupSnapshot(agency.superAdmin, c.org.id)).state).toBe("in_setup");
    const g = await getCrmSetupGuide(c.actor("viewer"));
    expect(g.facts.setup.readyRequestedAt).toBeTruthy();
  });
});

describe("CRM setup guide: tenant isolation", () => {
  it("never shows or changes another workspace's guide", async () => {
    const a = await client();
    const b = await client();
    await applySample(a.org.id);
    await saveCrmSetupGuide(a.actor("owner"), { currentStep: "workflows", answers: { channels: ["whatsapp"] } });
    const gb = await getCrmSetupGuide(b.actor("owner"));
    expect(gb).toMatchObject({ currentStep: "provider", revision: 0, answers: {} });
    expect(gb.facts.blueprint.applied).toEqual([]);
    expect(gb.facts.dataModel.tags).toBe(0);
    await saveCrmSetupGuide(b.actor("owner"), { currentStep: "tags" });
    expect((await getCrmSetupGuide(a.actor("owner"))).currentStep).toBe("workflows");
    // Row-level security: each owner reads only their own row, and nobody writes through the application role.
    expect((await withUser(b.people.owner.id, (db) => db.query("select org_id from crm_setup_guides where org_id = $1", [a.org.id]))).rows).toHaveLength(0);
    expect((await withUser(a.people.owner.id, (db) => db.query<{ org_id: string }>("select org_id from crm_setup_guides"))).rows.map((r) => r.org_id)).toEqual([a.org.id]);
    await expect(withUser(b.people.owner.id, (db) => db.query("update crm_setup_guides set current_step = 'review' where org_id = $1", [a.org.id]))).rejects.toThrow(/permission denied/i);
    await expect(withUser(a.people.owner.id, (db) => db.query("insert into crm_setup_guides (org_id) values ($1) on conflict do nothing", [a.org.id]))).rejects.toThrow(/permission denied/i);
  });
});

describe("CRM setup guide screen and actions", () => {
  it("renders the exact step with evidence-based statuses, editable for an owner and read-only for a viewer", async () => {
    const c = await client({ services: ["crm", "calendar"] });
    await applySample(c.org.id);
    await saveCrmSetupGuide(c.actor("owner"), { currentStep: "pipelines" });
    const render = async (whoIs: Parameters<CrmOrg["actor"]>[0]) => {
      const actor = c.actor(whoIs);
      const data = await getCrmSetupGuide(actor);
      return renderToStaticMarkup(React.createElement(CrmSetupGuide, { scope: await scopeFor(actor, "/crm"), data: JSON.parse(JSON.stringify(data)) }));
    };
    const html = await render("owner");
    expect(html).toContain("CRM setup guide");
    expect(html).toMatch(/Step 4 of 12/);
    expect(html).toContain("1 pipeline with 4 stages, matching your Blueprint.");
    expect(html).toContain("Verified");
    expect(html).toContain('href="/crm/pipelines"');
    expect(html).toContain("Saves as you go");
    const viewer = await render("viewer");
    expect(viewer).toContain("Owners and admins answer its questions.");
    expect(viewer).not.toContain("Saves as you go");
  });

  it("runs every action through the same permission checks", async () => {
    const c = await client();
    who.actor = c.actor("viewer");
    expect(await saveCrmSetupGuideAction(null, { currentStep: "tags" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await chooseInitialCrmProviderAction(null, "ghl")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await recheckCrmSetupAction(null)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await requestCrmSetupReviewAction(null)).toMatchObject({ ok: false, code: "forbidden" });
    who.actor = c.actor("owner");
    expect(await saveCrmSetupGuideAction(null, { currentStep: "tags", answers: { channels: ["email"] } })).toMatchObject({ ok: true, data: { currentStep: "tags" } });
    expect(await saveCrmSetupGuideAction(null, { currentStep: "nowhere" as CrmSetupStepKey })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await recheckCrmSetupAction(null)).toMatchObject({ ok: true });
    expect(await chooseInitialCrmProviderAction(null, "native")).toMatchObject({ ok: true, data: { mode: "native", changed: false } });
    who.actor = null;
  });
});

describe("onboarding review on iAcquire CRM", () => {
  it("talks about the Blueprint, not a GoHighLevel location, and stops asking once one is applied", async () => {
    const c = await client();
    const ctx = ctxFor(c.people.owner, c.org, "owner");
    let review = await getOnboardingReview(ctx);
    expect(review.missingConnections.find((m) => m.key === "crm")).toMatchObject({ label: "CRM not set up yet" });
    expect(review.humanTasks.find((t) => t.key === "crm")?.label).toMatch(/Blueprint/);
    expect(review.permissions.join(" ")).toMatch(/iAcquire CRM/);
    await applySample(c.org.id);
    review = await getOnboardingReview(ctx);
    expect(review.missingConnections.some((m) => m.key === "crm")).toBe(false);
  });
});
