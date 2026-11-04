// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeadsWorkspace } from "@/components/leads/leads-workspace";
import { targetingSchema } from "@/lib/leads-targeting";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/leads",
  useSearchParams: () => new URLSearchParams(),
}));

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

function renderWorkspace(lead: typeof baseLead) {
  return render(
    <LeadsWorkspace
      leads={[lead]}
      requests={[]}
      targeting={targetingSchema.parse({})}
      hunterReady={true}
      hunterStatus="online"
      canResearch={true}
      canReview={true}
      canExport={false}
      initialTab="review"
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
});
