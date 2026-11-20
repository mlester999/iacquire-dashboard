// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeadsWorkspace } from "@/components/leads/leads-workspace";
import { targetingSchema } from "@/lib/leads-targeting";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/leads",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const baseLead = {
  id: "a8ba9880-2ca7-40f4-9580-0d6711a40001",
  business_name: "Evidence Clinic",
  website: "https://clinic.example",
  domain: "clinic.example",
  industry: "Healthcare",
  location: "Denver",
  score: 76,
  score_breakdown: { service_fit: 25, problem_evidence: 18, buying_intent: 12, market_fit: 13, source_quality: 8 },
  qualification_summary: "The clinic is hiring scheduling staff and has a public website.",
  qualification_state: "evidence_backed" as const,
  qualification_reasons: ["At least one cited source, a website and a qualification explanation are present."],
  recommended_next_action: "Review the cited evidence and decide whether this lead fits.",
  buying_signals: ["Hiring scheduling staff"],
  signal_records: [{
    signal: "Hiring scheduling staff",
    source: "clinic.example",
    evidence_url: "https://clinic.example/careers",
    recorded_at: "2026-11-04T10:00:00.000Z",
    confidence: 0.78,
    client_fit: "Scheduling support is relevant to the stated service.",
  }],
  evidence: [{ url: "https://clinic.example/careers", observed_at: null, summary: "Hiring a scheduling coordinator." }],
  duplicate_status: "no_match",
  duplicate_matches: [],
  public_contact: {},
  review_status: "pending" as const,
  crm_sync_status: "not_synced",
  created_at: "2026-11-04T10:00:00.000Z",
};

function renderWorkspace(lead: React.ComponentProps<typeof LeadsWorkspace>["leads"][number], canUpload = false, initialTab = "review") {
  return render(
    <LeadsWorkspace
      leads={[lead]}
      requests={[]}
      targeting={targetingSchema.parse({})}
      hunterReady={true}
      hunterStatus="online"
      canResearch={true}
      canUpload={canUpload}
      canReview={true}
      canExport={false}
      initialTab={initialTab}
      timeZone="UTC"
    />,
  );
}

describe("lead signal review", () => {
  it("shows the cited source, timestamp, confidence estimate and server qualification action", async () => {
    renderWorkspace(baseLead);
    fireEvent.click(screen.getByRole("row", { name: /Evidence Clinic/ }));

    expect(await screen.findByText("Hiring scheduling staff")).toBeTruthy();
    expect(screen.getByText("AI estimate 78%")).toBeTruthy();
    expect(screen.getByText("Scheduling support is relevant to the stated service.")).toBeTruthy();
    expect(screen.getByText("Review the cited evidence and decide whether this lead fits.")).toBeTruthy();
    expect(screen.getByText(/Recorded/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /clinic\.example/ })[0].getAttribute("href")).toBe("https://clinic.example/careers");
  });

  it("labels legacy text signals as lacking per-signal evidence and confidence", async () => {
    renderWorkspace({ ...baseLead, buying_signals: ["Legacy signal"], signal_records: [] });
    fireEvent.click(screen.getByRole("row", { name: /Evidence Clinic/ }));

    expect(await screen.findByText("Older signals")).toBeTruthy();
    expect(screen.getByText("These records predate per-signal source links and confidence estimates.")).toBeTruthy();
  });

  it("displays workspace sources without an AI fit score", async () => {
    renderWorkspace({
      ...baseLead,
      source_platform: "tenant_upload",
      score: null,
      qualification_summary: null,
      signal_records: [],
      buying_signals: [],
      evidence: [{ url: "https://clinic.example/source", source: "tenant_upload", observed_at: null }],
    }, true);
    fireEvent.click(screen.getByRole("row", { name: /Evidence Clinic/ }));
    expect(await screen.findByText("Link supplied by your workspace")).toBeTruthy();
    expect(screen.getByText("Workspace CSV")).toBeTruthy();
    expect(screen.getByText("Source link supplied")).toBeTruthy();
    expect(screen.queryByText("of 100")).toBeNull();
  });

  it("requires a reviewer citation before approving a directory-only lead", async () => {
    renderWorkspace({
      ...baseLead,
      website: null,
      source_platform: "approved_source",
      qualification_state: "needs_evidence",
      evidence: [{ url: "https://ratings.food.gov.uk/business/42", source: "fsa_directory" }],
    });
    fireEvent.click(screen.getByRole("row", { name: /Evidence Clinic/ }));
    expect(await screen.findByRole("heading", { name: "Add first-party evidence" })).toBeTruthy();
    expect(screen.getByLabelText("Company page")).toHaveProperty("type", "url");
    expect(screen.getByRole("checkbox", { name: /I checked this public page/ })).toHaveProperty("required", true);
    expect(screen.queryByRole("button", { name: "Approve lead" })).toBeNull();
  });

  it("opens the linked native CRM task workspace after an approved import", async () => {
    const id = "a8ba9880-2ca7-40f4-9580-0d6711a40002";
    renderWorkspace({ ...baseLead, review_status: "approved", crm_sync_status: "synced", crm_company_id: id }, false, "all");
    fireEvent.click(screen.getByRole("row", { name: /Evidence Clinic/ }));
    expect((await screen.findByRole("link", { name: "Open CRM tasks" })).getAttribute("href")).toBe(`/crm/companies/${id}?tab=tasks`);
    expect(screen.queryByRole("button", { name: "Request CRM import" })).toBeNull();
  });

  it("requires a CSV and rights acknowledgement from workspace owners or admins", async () => {
    renderWorkspace(baseLead, true);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Upload CSV" }));
    expect(screen.getByLabelText("Company list")).toHaveProperty("required", true);
    expect(screen.getByRole("checkbox", { name: /My workspace has permission/ })).toHaveProperty("required", true);
    expect(screen.getByRole("link", { name: "Download CSV template" })).toHaveProperty("download", "iacquireos-lead-list.csv");
  });
});
