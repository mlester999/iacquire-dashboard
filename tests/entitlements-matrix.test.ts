// The entitlement matrix (Phase 7, M2). Three promises, each proved here and not only claimed:
//   1. One answer. The shell's menu, every Automation Studio gate, the engine and managed media storage read the plan through the same helper, so they can never disagree and a
//      past-due plan loses everything at the same instant (no raw query of the plan table decides an entitlement anywhere else).
//   2. Premium only. Every place that asks "is this workspace on the plan?" asks it on a premium path: Automation Studio itself, or a workflow that uses its steps.
//   3. Core is never gated. A workspace whose plan lapsed, whose fee was refunded or that never had a plan still does the everyday work of every core module.
// Embedded Postgres. No provider, model or network is used.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { AppError } from "@/server/errors";
import { workspaceEntitlements } from "@/server/entitlements";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { sweepStudioEntitlements } from "@/server/automation-studio/lifecycle";
import { getShellData } from "@/server/queries/shell";
import { getMediaPolicy } from "@/server/social/media";
import { createContact } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { createWorkflow } from "@/server/crm/workflows/definitions";
import { createCalendar } from "@/server/calendars/setup";
import { createPost, submitForApproval } from "@/server/social/posts";
import { sendHumanReply } from "@/server/messaging/inbox";
import { dispatchMessage } from "@/server/messaging/send";
import { createWebsite, getDraft } from "@/server/websites/service";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { runDueSchedules, saveSchedule } from "@/server/workforce/schedules";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { inbound, messagingOrg, recordingProvider } from "./support/messaging";
import { connect, socialOrg, textPost } from "./support/social";
import { clearSetupPayment } from "./support/billing";
import { coreWorkflowFor, DAY, inDays, planRow, setAgencyTimezone, taskDef, workflowRow, type PlanOptions } from "./support/billing-plan";

const posix = (p: string) => p.split(path.sep).join("/");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
});
const sourceOf = (file: string) => readFileSync(file, "utf8");
const SRC = walk("src");

// ---------------------------------------------------------------------------
// 1. One answer
// ---------------------------------------------------------------------------

/** Every state a workspace's plan can be in, as the plan fixture writes it, and whether each entitles Automation Studio and managed storage. */
const STATES: Array<{ name: string; plan: PlanOptions | null; entitled: boolean }> = [
  { name: "no plan at all", plan: null, entitled: false },
  { name: "a plan that was only requested", plan: { status: "requested" }, entitled: false },
  { name: "a declined request", plan: { status: "declined" }, entitled: false },
  { name: "an active plan", plan: { status: "active", paidThroughOn: inDays(new Date(), 20) }, entitled: true },
  { name: "an active plan whose paid period ended and nobody has recorded anything", plan: { status: "active", paidThroughOn: inDays(new Date(), -10) }, entitled: true },
  { name: "a plan waiting for its cancellation to be confirmed", plan: { status: "cancel_requested", paidThroughOn: inDays(new Date(), 5) }, entitled: true },
  { name: "a past-due plan inside its grace period", plan: { status: "past_due", graceEndsAt: new Date(Date.now() + 3 * DAY) }, entitled: true },
  { name: "a past-due plan whose grace period ended and the sweeper has not run", plan: { status: "past_due", pastDueSince: new Date(Date.now() - 9 * DAY), graceEndsAt: new Date(Date.now() - 60_000) }, entitled: false },
  { name: "an expired plan", plan: { status: "expired" }, entitled: false },
  { name: "a cancelled plan", plan: { status: "cancelled" }, entitled: false },
];

describe("one answer for the shell, the Studio gates, the engine and managed media storage", () => {
  it.each(STATES)("$name: all four agree (entitled=$entitled)", async ({ plan, entitled }) => {
    const s = await socialOrg();
    if (plan) await planRow(s.m, plan);

    const viaHelper = await withSystem((db) => workspaceEntitlements(db, s.m.org.id));
    const viaGate = await withSystem((db) => studioEntitlement(db, s.m.org.id));
    const viaShell = (await getShellData(s.owner)).automationStudio;
    const viaMedia = (await getMediaPolicy(s.owner)).managedUploadAllowed;

    expect(viaHelper.studio.entitled).toBe(entitled);
    expect(viaHelper.managedStorage).toBe(entitled);
    expect(viaGate).toEqual(viaHelper.studio);
    expect(viaShell).toEqual({ entitled });
    expect(viaMedia).toBe(entitled);
  });

  it("ends a past-due plan's storage and Studio together, at the instant its grace period ends, whether or not anything marked it expired", async () => {
    const o = await crmOrg();
    const grace = new Date(Date.now() + 2 * DAY);
    await planRow(o, { status: "past_due", pastDueSince: new Date(Date.now() - 5 * DAY), graceEndsAt: grace });
    const at = async (when: Date) => (await withSystem((db) => workspaceEntitlements(db, o.org.id, when)));
    const before = await at(new Date(grace.getTime() - 1));
    expect(before.studio.entitled && before.managedStorage).toBe(true);
    const atEnd = await at(grace);
    expect(atEnd.studio.entitled || atEnd.managedStorage).toBe(false);
    expect(atEnd.maintenance.status).toBe("past_due");
    // The row itself still says past_due: the helper decides from the clock, not from a job having run.
    expect((await withSystem((db) => db.query<{ status: string }>("select status from maintenance_subscriptions where org_id = $1", [o.org.id]))).rows[0].status).toBe("past_due");
  });

  it("reports the setup fee next to the plan without mixing them, and reads the day in the agency's time zone", async () => {
    const o = await crmOrg();
    await planRow(o, { status: "active", paidThroughOn: "2026-10-21" });
    expect((await withSystem((db) => workspaceEntitlements(db, o.org.id))).setupCleared).toBe(false);
    await clearSetupPayment(o.org.id);
    const cleared = await withSystem((db) => workspaceEntitlements(db, o.org.id, new Date("2026-10-21T12:00:00Z")));
    expect(cleared.setupCleared).toBe(true);
    expect(cleared.studio.entitled).toBe(true);
    // 18:00 UTC on the 21st is already the 22nd in Auckland: the paid-through day is the agency's day.
    await setAgencyTimezone("Pacific/Auckland");
    const late = await withSystem((db) => workspaceEntitlements(db, o.org.id, new Date("2026-10-21T18:00:00Z")));
    expect(late.maintenance).toMatchObject({ paidPeriodEnded: true, daysLeft: -1 });
    expect(late.studio.entitled).toBe(true);
  });
});

describe("no other code decides an entitlement from the plan table", () => {
  it("reads the plan's rows only where the plan is managed, and nowhere that decides what a workspace may use", () => {
    const readers = SRC.filter((f) => /maintenance_subscriptions/.test(sourceOf(f))).map(posix).sort();
    // billing/payments.ts locks and validates the plan a provider-verified period payment is for, and applies that period through the lifecycle's own transition; it decides no entitlement.
    expect(readers).toEqual([
      "src/server/automation-studio/lifecycle.ts",
      "src/server/billing/manual.ts",
      "src/server/billing/payments.ts",
      "src/server/db/index.ts",
      "src/server/entitlements.ts",
      "src/server/maintenance/lapse.ts",
      "src/server/maintenance/payment.ts",
      "src/server/maintenance/renewal.ts",
      "src/server/maintenance/service.ts",
    ]);
  });

  it("applies the entitlement rule in the shared library and the plan's own file, and calls it nowhere else (the one other caller is a sample-data preview page)", () => {
    const callers = SRC.filter((f) => /\bentitlementFor\(/.test(sourceOf(f))).map(posix).sort();
    expect(callers).toEqual(["src/app/dev/automation-studio-preview/page.tsx", "src/lib/automation-studio/plan.ts", "src/lib/entitlements.ts"]);
    // The preview feeds the rule invented sample plans, never a workspace's row, and is hidden in production.
    expect(sourceOf("src/app/dev/automation-studio-preview/page.tsx")).toMatch(/NODE_ENV === "production"/);
    expect(sourceOf("src/app/dev/automation-studio-preview/page.tsx")).not.toMatch(/maintenance_subscriptions|withSystem|withUser/);
  });

  it("gives managed media storage and the shell the shared helper, and gives text posts nothing to ask", () => {
    expect(sourceOf("src/server/social/media.ts")).toMatch(/workspaceEntitlements/);
    expect(sourceOf("src/server/social/media.ts")).not.toMatch(/maintenance_subscriptions|MANAGED_STATUSES/);
    expect(sourceOf("src/server/queries/shell.ts")).toMatch(/studioEntitlementOf/);
    expect(sourceOf("src/server/queries/shell.ts")).not.toMatch(/\bentitlementFor\b/);
    const askers = walk("src/server/social").filter((f) => /@\/server\/entitlements|@\/lib\/entitlements|studioEntitlement|assertStudioEntitled/.test(sourceOf(f))).map(posix);
    expect(askers).toEqual(["src/server/social/media.ts"]);
  });

  it("is imported only by server code that decides a premium question: never by a core module or a client component", () => {
    const importers = SRC.filter((f) => /from "@\/(server|lib)\/entitlements"/.test(sourceOf(f))).map(posix).sort();
    // The shell menu, the Studio gates, managed media storage and the Setup Center's storage line.
    for (const expected of ["src/server/automation-studio/entitlement.ts", "src/server/entitlements.ts", "src/server/queries/shell.ts", "src/server/social/media.ts"]) expect(importers).toContain(expected);
    const core = ["src/server/crm", "src/server/messaging", "src/server/calendars", "src/server/webchat", "src/server/websites", "src/server/sites", "src/server/chat", "src/server/leads", "src/server/missed-calls",
      "src/server/retention", "src/server/lead-scoring", "src/server/proposals", "src/server/invoices", "src/server/customer-payments", "src/server/reputation", "src/server/esign", "src/server/workforce"];
    for (const file of importers) {
      expect(file.startsWith("src/server/"), `${file} is server code`).toBe(true);
      expect(core.some((dir) => file.startsWith(`${dir}/`)), `${file} is not a core module`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Premium only
// ---------------------------------------------------------------------------

/** The lines of a source text that ask the plan question without a mention of "premium" on the same line or the four before it (the guard is how a call is shown to be premium-only). */
function unguardedPlanQuestions(source: string): number[] {
  const lines = source.split(/\r?\n/);
  const found: number[] = [];
  lines.forEach((line, i) => {
    if (!/\b(assertStudioEntitled|studioEntitlement)\(/.test(line) || /^\s*(import\b|\/\/|\*|\/\*)/.test(line)) return;
    if (!/[Pp]remium/.test(lines.slice(Math.max(0, i - 4), i + 1).join("\n"))) found.push(i + 1);
  });
  return found;
}

describe("every place that asks for the plan asks on a premium path", () => {
  const STUDIO_ONLY = ["src/server/automation-studio/builder/service.ts", "src/server/automation-studio/connections.ts"];
  const ENGINE = ["src/server/crm/blueprints/native-io/write.ts", "src/server/crm/workflows/approvals.ts", "src/server/crm/workflows/definitions.ts", "src/server/crm/workflows/inbound.ts", "src/server/crm/workflows/runner.ts", "src/server/crm/workflows/runs.ts", "src/server/crm/workflows/triggers.ts"];

  it("lists exactly the callers: Automation Studio's own modules and the workflow engine's premium paths", () => {
    const outsideStudio = SRC.filter((f) => /\b(assertStudioEntitled|studioEntitlement)\(/.test(sourceOf(f))).map(posix)
      .filter((f) => !f.startsWith("src/server/automation-studio/entitlement.ts") && !f.startsWith("src/components/automation-studio/") && f !== "src/server/automation-studio/lifecycle.ts");
    expect(outsideStudio.sort()).toEqual([...STUDIO_ONLY, ...ENGINE].sort());
  });

  it("guards every call in the workflow engine and the Blueprint writer with a premium test (and a core workflow reaches none of them)", () => {
    for (const file of ENGINE) expect(unguardedPlanQuestions(sourceOf(file)), file).toEqual([]);
  });

  it("recognises an unguarded question, so the check above can fail", () => {
    const guarded = ["if (isPremiumVersion(v)) {", "  await assertStudioEntitled(db, orgId, 'x');", "}"].join("\n");
    const unguarded = ["function publish() {", "  doThing();", "  more();", "  andMore();", "  yetMore();", "  await assertStudioEntitled(db, orgId, 'x');", "}"].join("\n");
    expect(unguardedPlanQuestions(guarded)).toEqual([]);
    expect(unguardedPlanQuestions(unguarded)).toEqual([6]);
    expect(unguardedPlanQuestions("import { assertStudioEntitled } from 'x';\n// assertStudioEntitled( is described here")).toEqual([]);
  });

  it("refuses a premium workflow to a lapsed workspace with the plan-required code, and builds the same workflow's core twin without the plan", async () => {
    const o = await crmOrg();
    await planRow(o, { status: "expired" });
    const refusal = await createWorkflow(o.actor("owner"), { name: "Studio only", definition: taskDef(), origin: "studio" }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AppError);
    expect((refusal as AppError).code).toBe("plan_required");
    const core = await coreWorkflowFor(o);
    expect(await workflowRow(core)).toMatchObject({ status: "active", origin: "crm", entitlement_paused_at: null });
  });
});

// ---------------------------------------------------------------------------
// 3. Core is never gated
// ---------------------------------------------------------------------------

const LAPSED: Array<{ name: string; plan: PlanOptions | null; fee: "refunded" | "not_invoiced" }> = [
  { name: "never had a plan", plan: null, fee: "not_invoiced" },
  { name: "an expired plan and a refunded setup fee", plan: { status: "expired" }, fee: "refunded" },
  { name: "a cancelled plan", plan: { status: "cancelled" }, fee: "not_invoiced" },
  { name: "a declined request", plan: { status: "declined" }, fee: "not_invoiced" },
  { name: "a past-due plan whose grace period ended", plan: { status: "past_due", pastDueSince: new Date(Date.now() - 9 * DAY), graceEndsAt: new Date(Date.now() - 60_000) }, fee: "not_invoiced" },
];

async function lapse(o: { org: { id: string }; people: { owner: { id: string } } }, state: (typeof LAPSED)[number]) {
  if (state.plan) await planRow(o, state.plan);
  await withSystem((db) => db.query("update billing_accounts set setup_payment_status = $2 where org_id = $1", [o.org.id, state.fee]));
  const e = await withSystem((db) => workspaceEntitlements(db, o.org.id));
  expect(e.studio.entitled, "the plan really is lapsed").toBe(false);
  expect(e.managedStorage).toBe(false);
}

describe("a workspace whose plan lapsed or never existed still does the everyday work of its core modules", () => {
  it.each(LAPSED)("CRM and booking, with $name, even after the scheduler's own lapse pass has run", async (state) => {
    const o = await crmOrg();
    const earlier = await coreWorkflowFor(o);
    await lapse(o, state);
    await sweepStudioEntitlements();
    expect(await workflowRow(earlier)).toMatchObject({ status: "active", entitlement_paused_at: null });
    const contact = await createContact(o.actor("owner"), { firstName: "Pat", lastName: "Lee" });
    expect(contact).toBeTruthy();
    await createTag(o.actor("owner"), { name: "Still works" });
    await createCalendar(o.actor("owner"), { name: "Front desk", members: [{ userId: o.people.owner.id }] });
    const core = await coreWorkflowFor(o);
    expect((await workflowRow(core)).status).toBe("active");
    // All six AI employees are still switched on: nothing about a plan or a fee touches them.
    const employees = (await withSystem((db) => db.query<{ enabled: boolean; status: string }>("select enabled, status from agent_instances where org_id = $1", [o.org.id]))).rows;
    expect(employees).toHaveLength(6);
    expect(employees.every((e) => e.enabled && e.status !== "disabled" && e.status !== "paused")).toBe(true);
  });

  it("the inbox: a person replies to a customer and the message goes out", async () => {
    const m = await messagingOrg({ name: "Matrix Inbox Co" });
    await lapse(m, LAPSED[1]);
    const c = await inbound(m.org.id, { name: "Lapsed Lena" });
    const queued = await sendHumanReply(m.ctx("manager"), c.conversationId, "Thanks Lena, we can come Thursday at 10.");
    expect(queued.status).toBe("queued");
    expect((await dispatchMessage(queued.messageId, { provider: recordingProvider().provider })).status).toBe("sent");
  });

  it("social text posts: a draft is written and sent for approval, while managed pictures and video are refused honestly", async () => {
    const s = await socialOrg();
    await lapse(s.m, LAPSED[4]);
    const account = await connect(s);
    const draft = await createPost(s.sales, textPost(account.id));
    expect(draft.status).toBe("draft");
    expect((await submitForApproval(s.sales, draft.id)).status).toBe("pending_approval");
    const policy = await getMediaPolicy(s.owner);
    expect(policy.managedUploadAllowed).toBe(false);
    expect(policy.summary).toMatch(/Text and link posts work now/);
  });

  describe("the AI employees and the website", () => {
    beforeAll(() => {
      process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
      process.env.SITES_PROBE_ORIGIN = "http://127.0.0.1:9";
      process.env.SITES_BASE_DOMAIN = "sites.test.example";
      process.env.SITES_CNAME_TARGET = "cname.sites.test.example";
      resetEnvCache();
    });
    afterAll(() => {
      delete process.env.WORKFORCE_SCHEDULES_ENABLED;
      delete process.env.SITES_PROBE_ORIGIN;
      delete process.env.SITES_BASE_DOMAIN;
      delete process.env.SITES_CNAME_TARGET;
      resetEnvCache();
    });

    async function world(name: string) {
      const org = await createOrg({ name });
      const owner = await createUser();
      await addMember(org.id, owner.id, "owner");
      return { org, owner, people: { owner }, ctx: ctxFor(owner, org, "owner") };
    }

    it("the AI employees: a saved assignment becomes a job that an employee completes", async () => {
      const w = await world("Matrix Employees Co");
      await lapse(w, LAPSED[1]);
      for (const role of ["operations_manager"] as const) {
        const id = await agentId(w.org.id, role);
        await withSystem((db) => createConfigVersion(db, { orgId: w.org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: w.owner.id, apply: true }));
      }
      await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [w.org.id]));
      const saved = await saveSchedule(w.ctx, { capability: "proactive_review", cadence: "daily", enabled: true });
      const now = new Date("2026-10-20T10:00:00.000Z");
      await withSystem((db) => db.query("update ai_work_schedules set next_run_at = $2 where id = $1", [saved.id, now.toISOString()]));
      const run = await runDueSchedules({ now });
      expect(run.created).toBe(1);
      const settle = async () => {
        for (let i = 0; i < 400; i += 1) {
          const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where id = $1", [run.jobIds[0]]));
          if (["completed", "failed", "cancelled", "blocked"].includes(rows[0].status)) return rows[0].status;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return "never settled";
      };
      expect(await settle()).toBe("completed");
    }, 60_000);

    it("the website: a first draft is built from the workspace's own facts", async () => {
      const w = await world("Matrix Website Co");
      await lapse(w, LAPSED[2]);
      await saveOnboardingStep(w.ctx, {
        answers: {
          "a.business_name": { value: "Matrix Website Co" }, "a.industry": { value: "home_services" }, "a.business_model": { value: "local" },
          "a.description": { value: "We repair and replace roofs for homeowners in Austin." }, "a.contact_phone": { value: "+15125550177" }, "a.contact_email": { value: "hello@matrix-website.test" },
          "a.territories": { value: "Austin, Round Rock" }, "b.services": { value: "Roof inspections, roof repairs, gutter replacement" },
        },
      });
      const { subdomain } = await createWebsite(w.ctx, { templateKey: "local.crew" });
      expect(subdomain).toBeTruthy();
      expect((await getDraft(w.ctx))?.content.pages.map((p) => p.slug)).toEqual(["home", "about", "services", "contact"]);
    }, 60_000);
  });
});
