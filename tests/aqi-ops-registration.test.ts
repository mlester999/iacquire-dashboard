import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JOBS } from "@/server/ops/tick";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { OPS_TOOLS } from "@/server/aqi/ops/registry";

/**
 * Everything AQi Operations added is wired in: pages, API routes, navigation, scheduled jobs, rate limits and the tools the planner and
 * the quick actions name. These are static checks, so a route or job that exists in a file but was never registered fails here.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const walk = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap((name) => {
  const rel = `${dir}/${name}`;
  return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
});

describe("API routes", () => {
  const routes = walk("src/app/api/aqi/ops").filter((file) => file.endsWith("/route.ts"));

  it("has the seven Operations routes, and the chat route is the only dispatcher between the two runtimes", () => {
    expect(routes.map((file) => file.replace("src/app/api/aqi/ops/", "").replace("/route.ts", "")).sort()).toEqual(
      ["actions/[id]", "briefings", "conversations", "conversations/[id]", "overview", "refresh", "scope"].sort(),
    );
    const chat = read("src/app/api/aqi/chat/route.ts");
    expect(chat).toMatch(/runOpsTurn/);
    expect(chat).toMatch(/runAqiTurn/);
    // The runtime comes from the server-resolved role, never from the request body.
    expect(chat).toMatch(/superAdmin\s*\?\s*runOpsTurn/);
  });

  it.each(walk("src/app/api/aqi/ops").filter((file) => file.endsWith("/route.ts")))("%s: every handler starts with the Super Admin guard, and every write is same-origin checked", (file) => {
    const source = read(file);
    const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b([\s\S]*?)(?=\nexport async function |\s*$)/g)];
    expect(handlers.length, file).toBeGreaterThan(0);
    for (const [, method, body] of handlers) {
      const firstCall = /requireOpsAdmin\(([^)]*)\)/.exec(body);
      expect(firstCall, `${file} ${method}`).not.toBeNull();
      // Nothing that reads the request or the database may come before the guard.
      expect(body.slice(0, body.indexOf("requireOpsAdmin(")), `${file} ${method}`).not.toMatch(/request\.(json|formData|text)|readSystem|withSystem|withUser|\.query\(/);
      if (method !== "GET") expect(firstCall![1], `${file} ${method}`).toMatch(/mutating:\s*true/);
    }
  });

  it("confirming an action re-authenticates with the auth server and is rate limited", () => {
    const route = read("src/app/api/aqi/ops/actions/[id]/route.ts");
    expect(route).toMatch(/requireOpsAdmin\(\{\s*mutating:\s*true,\s*fresh:\s*true\s*\}\)/);
    expect(read("src/server/aqi/ops/actions.ts")).toMatch(/RATE_LIMITS\.aqiOpsActionByUser/);
    expect(read("src/app/api/aqi/ops/refresh/route.ts")).toMatch(/RATE_LIMITS\.aqiOpsRefreshByUser/);
    expect(RATE_LIMITS.aqiOpsActionByUser).toBeDefined();
    expect(RATE_LIMITS.aqiOpsRefreshByUser).toBeDefined();
  });

  it("the refresh route can only re-run read tools", () => {
    const route = read("src/app/api/aqi/ops/refresh/route.ts");
    expect(route).toMatch(/findReadTool|kind === "read"/);
    expect(route).not.toMatch(/findActionTool|confirmOpsAction/);
  });
});

describe("page, navigation and route registry", () => {
  it("serves /admin/operations to Super Admins only, lists it in the admin navigation and the breadcrumb, and registers it with the assistant routes", () => {
    expect(read("src/app/(admin)/admin/operations/page.tsx")).toMatch(/requireAgency\("super_admin"\)/);
    expect(read("src/components/admin/admin-shell.tsx")).toMatch(/\/admin\/operations[\s\S]{0,200}superOnly/);
    expect(read("src/lib/admin-breadcrumb.ts")).toMatch(/operations:\s*"AQi Operations"/);
    expect(read("src/lib/aqi/routes.ts")).toMatch(/\/admin\/operations/);
  });

  it("mounts the Operations launcher only in Operations mode, so a client or manager is never offered it", () => {
    const providers = read("src/components/providers.tsx");
    expect(providers).toMatch(/aqiMode/);
    expect(providers).toMatch(/OpsLauncher/);
    expect(read("src/app/layout.tsx")).toMatch(/aqiMode/);
  });
});

describe("tools named elsewhere exist", () => {
  const known = new Set(OPS_TOOLS.map((tool) => tool.id));

  it("every tool the planner can plan, and every action it can propose, is registered", () => {
    const planner = read("src/server/aqi/ops/planner.ts");
    const named = new Set([...planner.matchAll(/\badd\("([a-z]+\.[a-z_]+)"/g), ...planner.matchAll(/toolId:\s*"([a-z]+\.[a-z_]+)"/g)].map((match) => match[1]));
    expect(named.size).toBeGreaterThan(15);
    for (const id of named) expect(known.has(id), id).toBe(true);
  });

  it("every tool the quick actions and overview name is registered", () => {
    for (const file of ["src/lib/aqi/ops/quick-actions.ts", "src/server/aqi/ops/overview.ts"]) {
      const ids = [...read(file).matchAll(/toolId:\s*"([a-z]+\.[a-z_]+)"/g)].map((match) => match[1]);
      for (const id of ids) expect(known.has(id), `${file}: ${id}`).toBe(true);
    }
  });

  it("registers every tool file's tools exactly once", () => {
    const ids = OPS_TOOLS.map((tool) => tool.id);
    expect(new Set(ids).size).toBe(ids.length);
    const files = walk("src/server/aqi/ops/tools").filter((file) => !file.endsWith("helpers.ts"));
    for (const file of files) {
      const declared = [...read(file).matchAll(/^\s+id:\s*"([a-z]+\.[a-z_]+)"/gm)].map((match) => match[1]);
      for (const id of declared) expect(known.has(id), `${file}: ${id}`).toBe(true);
    }
  });
});

describe("scheduled jobs", () => {
  it("registers the two AQi Operations jobs once each, after the support and incident jobs they depend on, and every tick", () => {
    const names = JOBS.map((job) => job.name);
    for (const name of ["aqiOperationsBriefings", "aqiOperationsRetention"]) {
      expect(names.filter((n) => n === name), name).toHaveLength(1);
      expect(JOBS.find((job) => job.name === name)?.everyMinutes, name).toBeUndefined();
    }
    expect(names.indexOf("aqiOperationsBriefings")).toBeGreaterThan(names.indexOf("incidentEscalations"));
    expect(names.indexOf("aqiOperationsRetention")).toBeGreaterThan(names.indexOf("aqiOperationsBriefings"));
  });

  it("keeps the shipped jobs, Automation Studio sweep, inbox attention scan, AQi Operations pair and gated workforce jobs registered", () => {
    const shipped = [
      "expiredReservations", "escalationsOpened", "followUpsPrepared", "repliesChecked", "approvalExpiry", "bookingHolds", "calendarBusySync", "calendarWriteBack",
      "appointmentReminders", "retentionPrograms", "crmEventDispatch", "crmWorkflowRuns", "crmFormSubmissions", "crmCampaigns", "messagesDispatched", "crmWebhookDeliveries",
      "websiteEnquiries", "crmImports", "crmProviderSwitches", "crmTaskReminders", "domainRenewals", "websiteHealth", "notificationEmails", "incidentChecks", "incidentEscalations",
      "supportResponseTargets", "supportEmails", "supportAutoClose", "supportAttachmentCleanup", "fairUseChecks", "inactivityReview", "offboardingReminders",
      "crmWorkflowRecovery", "whatsappTemplateSync", "setupEvidence", "aqiTutorialEventRetention",
    ];
    // The Automation Studio plan sweep sits right after the workflow housekeeping it follows; the inbox attention scan right after the reply checks;
    // lead re-scoring, the Phase 2 clean-up and missed-call recovery run just before the dispatcher, so what they queue goes out in the same run.
    const withStudio = shipped.flatMap((name) => (name === "crmWorkflowRecovery" ? [name, "studioEntitlementSweep"] : name === "repliesChecked" ? [name, "inboxAttention"] : name === "messagesDispatched" ? ["leadScoreReassessment", "phase2Retention", "missedCallRecovery", name] : [name]));
    expect(JOBS.map((job) => job.name)).toEqual([
      ...withStudio,
      "aqiOperationsBriefings",
      "aqiOperationsRetention",
      "aiWorkRecovery",
      "aiWorkSchedules",
      "aiWorkTriggers",
      "aiProactiveHeldReports",
      "aiProactiveBriefings",
    ]);
  });
});
