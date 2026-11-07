// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { withSystem } from "@/server/db";
import { saveResearchSourcePolicyAction } from "@/app/actions/leads";
import { ResearchSourceSettings } from "@/components/growth-partner/research-source-settings";
import {
  getResearchSourcePolicy,
  reserveResearchSourceRequest,
  saveResearchSourcePolicy,
} from "@/server/leads/research-source-policy";
import { createWorkJob } from "@/server/workforce/jobs";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

const auth = vi.hoisted(() => ({ currentContext: null as unknown, revalidatePath: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: auth.revalidatePath }));
vi.mock("@/server/tenancy/context", () => ({
  requireOrgContextOrThrow: vi.fn(async (permission: "leads.research") => {
    const ctx = auth.currentContext as { can: (permission: "leads.research") => boolean } | null;
    if (!ctx?.can(permission)) throw new Error("not authorized");
    return ctx;
  }),
}));

const OSM = {
  endpoint: "https://overpass-api.de/api/interpreter",
  approvedEndpointHosts: ["overpass-api.de"],
  userAgent: "iAcquireOS-acceptance-test/1.0",
  bounds: { south: 28.1, west: -81.6, north: 28.8, east: -81.1 },
  maxResults: 10,
  timeoutSeconds: 20,
};

function osmForm(options: {
  enabled?: boolean;
  acknowledged?: boolean;
  fee?: number;
  perJobRequests?: number;
  perDayRequests?: number;
  perJobSpend?: number;
  perDaySpend?: number;
  endpoint?: string;
  approvedHost?: string;
} = {}) {
  const form = new FormData();
  const fields: Record<string, string> = {
    source: "openstreetmap",
    enabled: options.enabled ? "true" : "false",
    activationAcknowledged: options.acknowledged ? "true" : "false",
    providerFeeUsdPerRequest: String(options.fee ?? (options.enabled ? 0.25 : 0)),
    perJobRequestCap: String(options.perJobRequests ?? 3),
    perDayRequestCap: String(options.perDayRequests ?? 5),
    perJobSpendCapUsd: String(options.perJobSpend ?? 0.25),
    perDaySpendCapUsd: String(options.perDaySpend ?? 0.5),
    endpoint: options.endpoint ?? OSM.endpoint,
    approvedEndpointHosts: options.approvedHost ?? OSM.approvedEndpointHosts[0]!,
    userAgent: OSM.userAgent,
    boundsSouth: String(OSM.bounds.south),
    boundsWest: String(OSM.bounds.west),
    boundsNorth: String(OSM.bounds.north),
    boundsEast: String(OSM.bounds.east),
    maxResults: String(OSM.maxResults),
    timeoutSeconds: String(OSM.timeoutSeconds),
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

function websiteForm() {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    source: "company_website",
    enabled: "true",
    activationAcknowledged: "true",
    providerFeeUsdPerRequest: "999",
    approvedDomains: "orlando-roofing-alpha.test\nwinter-park-roofing.test",
    maxRequests: "4",
    perJobRequestCap: "10",
    perDayRequestCap: "20",
    perJobSpendCapUsd: "0",
    perDaySpendCapUsd: "0",
  })) form.set(key, value);
  return form;
}

async function researchWork(orgId: string, userId: string) {
  const runtime = await agentId(orgId, "lead_hunter");
  return withSystem(async (db) => {
    const work = await createWorkJob(db, {
      orgId,
      agentId: runtime,
      requestedBy: userId,
      capability: "lead_research",
      title: "Source policy budget test",
      idempotencyKey: `source-policy-acceptance:${crypto.randomUUID()}`,
      input: {},
    });
    const request = await db.query<{ id: string }>(
      `insert into lead_research_requests (org_id, requested_by, prompt, status, work_job_id, agent_role)
       values ($1, $2, 'Synthetic source policy test', 'queued', $3, 'lead_hunter') returning id`,
      [orgId, userId, work.id],
    );
    return { jobId: work.id, requestId: request.rows[0]!.id };
  });
}

describe("source-settings UI and backend acceptance", () => {
  let org: Awaited<ReturnType<typeof createOrg>>;
  let owner: Awaited<ReturnType<typeof createUser>>;
  let member: Awaited<ReturnType<typeof createUser>>;
  let ownerContext: ReturnType<typeof ctxFor>;
  let memberContext: ReturnType<typeof ctxFor>;

  beforeEach(async () => {
    org = await createOrg({ name: "Research Source Settings Acceptance" });
    owner = await createUser({ name: "Source Settings Owner" });
    member = await createUser({ name: "Source Settings Member" });
    await addMember(org.id, owner.id, "owner");
    await addMember(org.id, member.id, "member");
    ownerContext = ctxFor(owner, org, "owner");
    memberContext = ctxFor(member, org, "member");
    auth.currentContext = ownerContext;
    auth.revalidatePath.mockReset();
  });

  it("renders both sources disabled and activation acknowledgement unchecked by default", () => {
    const html = renderToStaticMarkup(createElement(ResearchSourceSettings, {
      policies: { openstreetmap: null, company_website: null },
    }));
    const switches = [...html.matchAll(/<input[^>]*role="switch"[^>]*>/g)].map(([tag]) => tag ?? "");
    const acknowledgements = [...html.matchAll(/<input[^>]*name="activationAcknowledged"[^>]*>/g)].map(([tag]) => tag ?? "");
    expect(switches).toHaveLength(2);
    expect(switches.every((tag) => !/\schecked(?:=|\s|>)/.test(tag))).toBe(true);
    expect(acknowledgements).toHaveLength(2);
    expect(acknowledgements.every((tag) => !/\schecked(?:=|\s|>)/.test(tag))).toBe(true);
    expect(html).toContain("Owner and admin settings");
    expect(html).toContain("Saving stores limits; it does not start discovery.");
  });

  it("saves through the rendered form and reloads the persisted source policy", async () => {
    const user = userEvent.setup();
    const page = render(<ResearchSourceSettings policies={{ openstreetmap: null, company_website: null }} />);
    const form = screen.getByRole("form", { name: "Configure OpenStreetMap discovery" });
    const setField = async (label: string, value: string) => {
      const field = within(form).getByLabelText(label) as HTMLInputElement;
      await user.clear(field);
      await user.type(field, value);
    };

    await user.click(within(form).getByRole("switch", { name: "Allow OpenStreetMap discovery requests" }));
    await setField("Provider fee per request (USD)", "0.25");
    await setField("Exact allowed server host", "overpass-api.de");
    await setField("Maximum requests per job", "3");
    await setField("Maximum requests per day", "5");
    await setField("Provider spend cap per job (USD)", "0.25");
    await setField("Provider spend cap per day (USD)", "0.50");

    const advanced = form.querySelector("details");
    expect(advanced).not.toBeNull();
    advanced!.open = true;
    await setField("Reviewed HTTPS endpoint", OSM.endpoint);
    await setField("Identifying User-Agent", OSM.userAgent);
    await setField("South latitude", String(OSM.bounds.south));
    await setField("West longitude", String(OSM.bounds.west));
    await setField("North latitude", String(OSM.bounds.north));
    await setField("East longitude", String(OSM.bounds.east));
    await user.click(within(form).getByRole("checkbox", { name: /I approve bounded, read-only requests/ }));
    await user.click(within(form).getByRole("button", { name: "Save settings" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/saved/i);
    const persisted = await withSystem((db) => getResearchSourcePolicy(db, org.id, "openstreetmap"));
    expect(persisted).toMatchObject({
      enabled: true,
      approvedBy: owner.id,
      providerFeeUsdPerRequest: 0.25,
      perJobRequestCap: 3,
      perDayRequestCap: 5,
      perJobSpendCapUsd: 0.25,
      perDaySpendCapUsd: 0.5,
      sourceConfig: { endpoint: OSM.endpoint, approvedEndpointHosts: OSM.approvedEndpointHosts, bounds: OSM.bounds },
    });
    expect(auth.revalidatePath).toHaveBeenCalledWith("/growth-partner");

    page.unmount();
    const reloaded = render(<ResearchSourceSettings policies={{
      openstreetmap: {
        enabled: persisted!.enabled,
        providerFeeUsdPerRequest: persisted!.providerFeeUsdPerRequest,
        perJobRequestCap: persisted!.perJobRequestCap,
        perDayRequestCap: persisted!.perDayRequestCap,
        perJobSpendCapUsd: persisted!.perJobSpendCapUsd,
        perDaySpendCapUsd: persisted!.perDaySpendCapUsd,
        sourceConfig: persisted!.sourceConfig as Record<string, unknown>,
      },
      company_website: null,
    }} />);
    const reloadedForm = screen.getByRole("form", { name: "Configure OpenStreetMap discovery" });
    expect((within(reloadedForm).getByRole("switch", { name: "Allow OpenStreetMap discovery requests" }) as HTMLInputElement).checked).toBe(true);
    expect((within(reloadedForm).getByLabelText("Provider fee per request (USD)") as HTMLInputElement).value).toBe("0.25");
    expect((within(reloadedForm).getByLabelText("Maximum requests per job") as HTMLInputElement).value).toBe("3");
    reloaded.unmount();
  });

  it("persists approved limits through the server action and rejects unauthorized action and direct service calls", async () => {
    const initial = await withSystem((db) => getResearchSourcePolicy(db, org.id, "openstreetmap"));
    expect(initial).toBeNull();

    const saved = await saveResearchSourcePolicyAction({ status: "idle", message: "" }, osmForm({ enabled: false, perJobRequests: 0, perDayRequests: 0, perJobSpend: 0, perDaySpend: 0 }));
    expect(saved.status).toBe("success");
    const persistedDisabled = await withSystem((db) => getResearchSourcePolicy(db, org.id, "openstreetmap"));
    expect(persistedDisabled).toMatchObject({ enabled: false, providerFeeUsdPerRequest: 0, perJobRequestCap: 0, perDayRequestCap: 0 });

    auth.currentContext = memberContext;
    const deniedAction = await saveResearchSourcePolicyAction({ status: "idle", message: "" }, osmForm({ enabled: false, perJobRequests: 0, perDayRequests: 0, perJobSpend: 0, perDaySpend: 0 }));
    expect(deniedAction).toMatchObject({ status: "error" });
    await expect(saveResearchSourcePolicy(memberContext, "openstreetmap", {
      enabled: false,
      providerFeeUsdPerRequest: 0,
      perJobRequestCap: 0,
      perDayRequestCap: 0,
      perJobSpendCapUsd: 0,
      perDaySpendCapUsd: 0,
      sourceConfig: OSM,
    })).rejects.toThrow(/Only workspace owners and admins/);
    expect(await withSystem((db) => getResearchSourcePolicy(db, org.id, "openstreetmap"))).toMatchObject({ enabled: false, perJobRequestCap: 0 });
  });

  it("enforces acknowledgement, exact endpoints, request and spend caps, and zero-fee website policy on the backend", async () => {
    const enabledWithoutAcknowledgement = await saveResearchSourcePolicyAction(
      { status: "idle", message: "" },
      osmForm({ enabled: true, acknowledged: false }),
    );
    expect(enabledWithoutAcknowledgement).toMatchObject({ status: "error", message: expect.stringMatching(/Confirm/) });

    await expect(saveResearchSourcePolicy(ownerContext, "openstreetmap", {
      enabled: true,
      providerFeeUsdPerRequest: 0.25,
      perJobRequestCap: 3,
      perDayRequestCap: 5,
      perJobSpendCapUsd: 0.25,
      perDaySpendCapUsd: 0.5,
      activationAcknowledged: true,
      sourceConfig: { ...OSM, endpoint: "https://unapproved.example/api/interpreter" },
    })).rejects.toThrow(/exact allowlist/);
    await expect(saveResearchSourcePolicy(ownerContext, "openstreetmap", {
      enabled: true,
      providerFeeUsdPerRequest: 0.25,
      perJobRequestCap: 0,
      perDayRequestCap: 5,
      perJobSpendCapUsd: 0.25,
      perDaySpendCapUsd: 0.5,
      activationAcknowledged: true,
      sourceConfig: OSM,
    })).rejects.toThrow(/positive per-job and per-day/);
    await expect(saveResearchSourcePolicy(ownerContext, "company_website", {
      enabled: true,
      providerFeeUsdPerRequest: 1,
      perJobRequestCap: 3,
      perDayRequestCap: 5,
      perJobSpendCapUsd: 1,
      perDaySpendCapUsd: 2,
      activationAcknowledged: true,
      sourceConfig: { approvedDomains: ["orlando-roofing-alpha.test"], maxRequests: 4 },
    })).rejects.toThrow(/\$0\.00 provider fee/);

    const enabled = await saveResearchSourcePolicyAction(
      { status: "idle", message: "" },
      osmForm({ enabled: true, acknowledged: true }),
    );
    expect(enabled.status).toBe("success");
    const policy = await withSystem((db) => getResearchSourcePolicy(db, org.id, "openstreetmap"));
    expect(policy).toMatchObject({
      enabled: true,
      approvedBy: owner.id,
      providerFeeUsdPerRequest: 0.25,
      perJobRequestCap: 3,
      perDayRequestCap: 5,
      perJobSpendCapUsd: 0.25,
      perDaySpendCapUsd: 0.5,
    });

    const job1 = await researchWork(org.id, owner.id);
    await expect(reserveResearchSourceRequest({ orgId: org.id, ...job1, source: "openstreetmap", requestUrl: "https://unapproved.example/api/interpreter" })).rejects.toThrow(/exact approved OpenStreetMap endpoint/);
    await expect(reserveResearchSourceRequest({ orgId: org.id, ...job1, source: "openstreetmap", requestUrl: "https://overpass-api.de/not-the-interpreter" })).rejects.toThrow(/exact approved OpenStreetMap endpoint/);
    const first = await reserveResearchSourceRequest({ orgId: org.id, ...job1, source: "openstreetmap", requestUrl: OSM.endpoint });
    expect(first.policy.providerFeeUsdPerRequest).toBe(0.25);
    await expect(reserveResearchSourceRequest({ orgId: org.id, ...job1, source: "openstreetmap", requestUrl: OSM.endpoint })).rejects.toThrow(/spend cap/);

    const job2 = await researchWork(org.id, owner.id);
    await reserveResearchSourceRequest({ orgId: org.id, ...job2, source: "openstreetmap", requestUrl: OSM.endpoint });
    const job3 = await researchWork(org.id, owner.id);
    await expect(reserveResearchSourceRequest({ orgId: org.id, ...job3, source: "openstreetmap", requestUrl: OSM.endpoint })).rejects.toThrow(/spend cap/);

    const website = await saveResearchSourcePolicyAction({ status: "idle", message: "" }, websiteForm());
    expect(website.status).toBe("success");
    expect(await withSystem((db) => getResearchSourcePolicy(db, org.id, "company_website"))).toMatchObject({
      enabled: true,
      providerFeeUsdPerRequest: 0,
      approvedBy: owner.id,
      sourceConfig: { approvedDomains: ["orlando-roofing-alpha.test", "winter-park-roofing.test"], maxRequests: 4 },
    });
    const websiteJob = await researchWork(org.id, owner.id);
    await expect(reserveResearchSourceRequest({
      orgId: org.id,
      ...websiteJob,
      source: "company_website",
      requestUrl: "https://unapproved.example/contact",
    })).rejects.toThrow(/exact domain approved/);
    const { rows: usage } = await withSystem((db) => db.query<{ count: number; total_fee: string }>(
      `select count(*)::int as count, coalesce(sum(provider_fee_usd),0)::text as total_fee
         from lead_research_source_usage where org_id = $1`,
      [org.id],
    ));
    expect(usage[0]).toEqual({ count: 2, total_fee: "0.500000" });
    expect(auth.revalidatePath).toHaveBeenCalledWith("/growth-partner");
  });

  it("enforces per-job and per-day request caps independently of spend caps", async () => {
    const enabled = await saveResearchSourcePolicyAction(
      { status: "idle", message: "" },
      osmForm({
        enabled: true,
        acknowledged: true,
        fee: 0.1,
        perJobRequests: 1,
        perDayRequests: 2,
        perJobSpend: 1,
        perDaySpend: 1,
      }),
    );
    expect(enabled.status).toBe("success");

    const firstJob = await researchWork(org.id, owner.id);
    await reserveResearchSourceRequest({ orgId: org.id, ...firstJob, source: "openstreetmap", requestUrl: OSM.endpoint });
    await expect(reserveResearchSourceRequest({ orgId: org.id, ...firstJob, source: "openstreetmap", requestUrl: OSM.endpoint }))
      .rejects.toThrow(/per-job request cap/);

    const secondJob = await researchWork(org.id, owner.id);
    await reserveResearchSourceRequest({ orgId: org.id, ...secondJob, source: "openstreetmap", requestUrl: OSM.endpoint });
    const thirdJob = await researchWork(org.id, owner.id);
    await expect(reserveResearchSourceRequest({ orgId: org.id, ...thirdJob, source: "openstreetmap", requestUrl: OSM.endpoint }))
      .rejects.toThrow(/per-day request cap/);
  });
});
