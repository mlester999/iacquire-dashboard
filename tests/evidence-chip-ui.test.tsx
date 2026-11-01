// @vitest-environment jsdom
// The chip that says what kind of reply a chat message is. A missing, legacy or damaged marker renders nothing, "Done" appears only for a confirmed action, and the time a model's
// records were read is shown in the viewer's own time zone. The same chip sits on the job panel and the Approval Center, where the words around it (a draft that is "waiting to
// send", a review that "checked 0 deals") must not claim more than the records show.
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EvidenceChip } from "@/components/chat/evidence-chip";
import { ApprovalCenter } from "@/components/approvals/approval-center";
import { WorkJobPanel, type WorkJob } from "@/components/work/job-progress";
import { EVIDENCE_CLASSES } from "@/lib/evidence-class";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("@/app/actions/work", () => ({ createFindingTaskAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({ approvalEventsAction: vi.fn(async () => ({ ok: true as const, data: [] })), decideApprovalAction: vi.fn() }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const READ_AT = "2026-10-26T06:00:00.000Z";
const render1 = (evidence: unknown, timeZone?: string) => render(<EvidenceChip evidence={evidence} timeZone={timeZone} />);

describe("the evidence chip", () => {
  it.each([
    ["model_response", "Written by AI"],
    ["record_retrieval", "Read from your records"],
    ["proposed_change", "Proposed, not applied"],
    ["approved_write", "Approved and applied"],
    ["completed_action", "Done, confirmed"],
    ["system_notice", "System notice"],
  ])("shows %s as %s, with the class on the element and an explanation for a screen reader and a tooltip", (cls, label) => {
    const { container } = render1({ v: 1, class: cls });
    const chip = container.querySelector("[data-evidence-class]") as HTMLElement;
    expect(chip.getAttribute("data-evidence-class")).toBe(cls);
    expect(chip.textContent).toContain(label);
    expect(chip.getAttribute("title")?.length).toBeGreaterThan(20);
    expect(chip.querySelector(".sr-only")?.textContent).toContain(chip.getAttribute("title") as string);
  });

  it("says Done or Completed only for a confirmed action, anywhere in what it renders", () => {
    for (const cls of EVIDENCE_CLASSES) {
      const { container } = render1({ v: 1, class: cls });
      const text = `${container.textContent} ${container.querySelector("[title]")?.getAttribute("title")}`;
      if (cls === "completed_action") expect(text).toMatch(/\bdone\b/i);
      else expect(text, cls).not.toMatch(/\b(done|completed?)\b/i);
      cleanup();
    }
  });

  it("names when a model's records were read in the viewer's own zone, and which areas", () => {
    const marker = { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "calendar", state: "ready" }, { id: "crm", state: "empty" }] } };
    const manila = render1(marker, "Asia/Manila");
    expect(manila.container.textContent).toContain("Written by AI, using records read at 2:00 PM");
    expect(manila.container.querySelector("[title]")?.getAttribute("title")).toContain("calendar (ready)");
    cleanup();
    const chicago = render1(marker, "America/Chicago");
    expect(chicago.container.textContent).toContain("1:00 AM");
  });

  it("does not claim records were read when none were", () => {
    const { container } = render1({ v: 1, class: "model_response" });
    expect(container.textContent).toContain("Written by AI");
    expect(container.textContent).not.toContain("using records");
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("No verified records were read");
  });

  it("warns on a model reply flagged for describing an action nobody recorded", () => {
    const { container } = render1({ v: 1, class: "model_response", claims: "unbacked_action_claim" });
    expect(container.textContent).toContain("unconfirmed");
  });

  it.each<[string, unknown]>([
    ["no marker (a legacy message)", null],
    ["an undefined marker", undefined],
    ["a string", "system_notice"],
    ["an array", [{ v: 1, class: "system_notice" }]],
    ["an unknown class", { v: 1, class: "guess" }],
    ["a wrong version", { v: 2, class: "system_notice" }],
    ["an unknown key", { v: 1, class: "system_notice", extra: 1 }],
    ["records on a notice", { v: 1, class: "system_notice", records: { readAt: READ_AT, areas: [{ id: "crm", state: "ready" }] } }],
    ["records with an unreadable time", { v: 1, class: "model_response", records: { readAt: "later", areas: [{ id: "crm", state: "ready" }] } }],
    ["an area with an unknown state", { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "crm", state: "fine" }] } }],
  ])("renders nothing for %s", (_label, evidence) => {
    const { container } = render1(evidence);
    expect(container.innerHTML).toBe("");
  });

  it("falls back to UTC for a time zone it does not know, instead of failing the page", () => {
    const { container } = render1({ v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "crm", state: "ready" }] } }, "Not/AZone");
    expect(container.textContent).toContain("6:00 AM");
  });
});

function job(overrides: Partial<WorkJob> = {}): WorkJob {
  return {
    id: "job-1", capability: "pipeline_review", title: "Pipeline review", status: "completed", statusLabel: "Completed", recoveryPending: false, stage: "completed", stageLabel: "Completed",
    progress: {}, result: {}, resultSummary: "Review complete.", resultCount: 0, failureCode: null, failureMessage: null, attempts: 1, cancelRequested: false, canCancel: false, canRetry: false,
    canCreateTask: false, conversationId: null, createdAt: "2026-10-26T06:00:00.000Z", startedAt: "2026-10-26T06:00:01.000Z", finishedAt: "2026-10-26T06:00:05.000Z", elapsedMs: 4000, events: [],
    ...overrides,
  };
}
function showJob(value: WorkJob) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ job: value }), { status: 200, headers: { "content-type": "application/json" } })));
  return render(<WorkJobPanel jobId={value.id} />);
}

describe("the job panel", () => {
  it("shows a finished review as read from the person's records, and a draft job as a proposal that is ready for review, never as done", async () => {
    const review = showJob(job({ evidence: { v: 1, class: "record_retrieval", ledger: { kind: "work_job", id: "job-1" } } }));
    expect(await screen.findByText("Review complete.")).toBeTruthy();
    expect(review.container.querySelector("[data-evidence-class='record_retrieval']")?.textContent).toContain("Read from your records");
    expect(review.container.textContent).not.toMatch(/\bdone\b/i);
    cleanup();

    const drafts = showJob(job({ capability: "pipeline_followup_drafts", statusLabel: "Ready for review", evidence: { v: 1, class: "proposed_change", ledger: { kind: "work_job", id: "job-1" } } }));
    expect(await screen.findByText("Review complete.")).toBeTruthy();
    expect(drafts.container.querySelector("[data-evidence-class='proposed_change']")?.textContent).toContain("Proposed, not applied");
    expect(screen.getByText("Ready for review")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it.each<[string, unknown]>([
    ["no marker", undefined],
    ["a null marker (work that has produced nothing)", null],
    ["a damaged marker", { v: 1, class: "guess" }],
    ["a model-only field on a job", { v: 1, class: "record_retrieval", claims: "none_found" }],
  ])("renders no chip for %s", async (_label, evidence) => {
    const view = showJob(job({ evidence }));
    expect(await screen.findByText("Review complete.")).toBeTruthy();
    expect(view.container.querySelector("[data-evidence-class]")).toBeNull();
  });

  it("says what a review looked at when the result records it, and nothing when it does not", async () => {
    const seeded = showJob(job({ result: { examined: [{ label: "deals", count: 0 }, { label: "contacts", count: 3 }] } }));
    expect((await screen.findByTestId("work-examined")).textContent).toBe("Checked 0 deals, 3 contacts.");
    seeded.unmount();

    const single = showJob(job({ result: { examined: [{ label: "deals", count: 1 }, { label: "companies", count: 1 }] } }));
    expect((await screen.findByTestId("work-examined")).textContent).toBe("Checked 1 deal, 1 company.");
    single.unmount();

    for (const examined of [undefined, [], "deals", [{ label: "deals", count: -1 }], [{ label: "deals", count: "3" }], [{ count: 2 }], [{ label: "x".repeat(80), count: 2 }], [null]]) {
      const none = showJob(job({ result: examined === undefined ? {} : { examined } }));
      expect(await screen.findByText("Review complete.")).toBeTruthy();
      expect(screen.queryByTestId("work-examined"), JSON.stringify(examined)).toBeNull();
      none.unmount();
    }
  });

  it("shows each draft's live status, and stops promising that nothing was sent once one is approved", async () => {
    const draft = (messageId: string, name: string, liveStatus: string, liveDetail: string | null = null) => ({ opportunityName: name, messageId, conversationId: "c-1", status: "draft", sent: false, liveStatus, liveDetail });
    const waitingOnly = showJob(job({ capability: "pipeline_followup_drafts", result: { drafts: [draft("m1", "Roof repair for Cruz", "waiting")] } }));
    expect(await screen.findByText("Draft waiting")).toBeTruthy();
    expect(screen.getByText("Roof repair for Cruz")).toBeTruthy();
    expect(screen.getByText(/Drafts stay unsent until a person reviews them\. Nothing was sent\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Inbox" }).getAttribute("href")).toBe("/inbox?conversation=c-1");
    waitingOnly.unmount();

    showJob(job({
      capability: "pipeline_followup_drafts",
      result: {
        drafts: [
          draft("m1", "One", "approved_queued"), draft("m2", "Two", "sent"), draft("m3", "Three", "blocked", "Outside quiet hours."),
          draft("m4", "Four", "discarded"), draft("m5", "Five", "unknown"), draft("m6", "Six", "waiting"),
        ],
      },
    }));
    expect(await screen.findByText("Approved, queued")).toBeTruthy();
    for (const text of ["Sent", "Blocked: Outside quiet hours.", "Discarded", "Status unavailable", "Draft waiting"]) expect(screen.getByText(text), text).toBeTruthy();
    expect(screen.queryByText(/Nothing was sent/)).toBeNull();
    expect(screen.getByText(/A draft is sent only after a person approves it/)).toBeTruthy();
  });

  it("ignores a draft list with no live status (an older result) instead of guessing one", async () => {
    showJob(job({ capability: "pipeline_followup_drafts", result: { drafts: [{ opportunityName: "Old", messageId: "m1", status: "draft", sent: false }, { liveStatus: "made-up" }, null] } }));
    expect(await screen.findByText("Review complete.")).toBeTruthy();
    expect(screen.queryByText("Follow-up drafts")).toBeNull();
    expect(screen.getByText(/Drafts stay unsent until a person reviews them/)).toBeTruthy();
  });
});

function approval(overrides: Record<string, unknown>) {
  return {
    id: "a-1", kind: "follow_up_message", title: "Send AI reply", target_type: null, target_label: null, reason: "r", expected_effect: "e", risk: "medium", status: "approved",
    execution_status: "succeeded", execution_detail: null, expires_at: null, decided_at: "2026-10-26T06:00:00.000Z", decision_note: null, created_at: "2026-10-26T05:00:00.000Z",
    agent_role: null, requested_by_name: "Owner", decided_by_name: "Owner", outcome: null, evidence: null, ...overrides,
  };
}
const showApprovals = (rows: Array<Record<string, unknown>>) => render(<ApprovalCenter approvals={rows as never} canDecide={false} canDecideHigh={false} timeZone="UTC" />);

describe("the Approval Center", () => {
  it("says exactly what an approved request came to, and puts the class chip only where it adds something", () => {
    const view = showApprovals([
      approval({ id: "queued", title: "Draft queued", outcome: { label: "Approved, waiting to send", tone: "neutral", detail: "Queued for sending." }, evidence: { v: 1, class: "approved_write", ledger: { kind: "approval", id: "queued" } } }),
      approval({ id: "blocked", title: "Draft blocked", outcome: { label: "Approved, but not sent", tone: "danger", detail: "Outside quiet hours." }, evidence: { v: 1, class: "proposed_change", ledger: { kind: "approval", id: "blocked" } } }),
      approval({ id: "sent", title: "Draft sent", outcome: { label: "Sent", tone: "success", detail: null }, evidence: { v: 1, class: "completed_action", ledger: { kind: "approval", id: "sent" } } }),
      approval({ id: "booking", kind: "appointment_booking", title: "Booking", outcome: { label: "Completed", tone: "success", detail: null }, evidence: { v: 1, class: "completed_action", ledger: { kind: "approval", id: "booking" } } }),
    ]);
    const row = (title: string) => screen.getByText(title).closest("li") as HTMLElement;
    expect(row("Draft queued").textContent).toContain("Approved, waiting to send");
    // "Approved and applied" next to "waiting to send" would contradict it, so an approved write has no class chip.
    expect(row("Draft queued").querySelector("[data-evidence-class]")).toBeNull();
    expect(row("Draft queued").textContent).not.toMatch(/\b(Completed|Done|Sent)\b/);

    expect(row("Draft blocked").textContent).toContain("Approved, but not sent");
    expect(row("Draft blocked").querySelector("[data-evidence-class='proposed_change']")).not.toBeNull();
    expect(row("Draft blocked").textContent).not.toMatch(/\b(Completed|Done)\b/);

    expect(row("Draft sent").textContent).toContain("Sent");
    expect(row("Booking").textContent).toContain("Completed");
    expect(row("Booking").querySelector("[data-evidence-class='completed_action']")?.textContent).toContain("Done, confirmed");
    // The old wording is gone: a held request is not "integration not enabled" by default, and nothing says Failed for a blocked send.
    expect(view.container.textContent).not.toContain("Held — integration not enabled");
  });

  it("shows a request nobody has approved as proposed, not applied, with no outcome", () => {
    showApprovals([approval({ id: "p", title: "Waiting for you", status: "pending", execution_status: "not_started", outcome: null, evidence: { v: 1, class: "proposed_change", ledger: { kind: "approval", id: "p" } } })]);
    const row = screen.getByText("Waiting for you").closest("li") as HTMLElement;
    expect(row.querySelector("[data-evidence-class='proposed_change']")?.textContent).toContain("Proposed, not applied");
    expect(row.textContent).not.toMatch(/Approved|Completed|Sent/);
  });

  it("draws nothing extra for an older row with no marker or outcome", () => {
    showApprovals([approval({ id: "old", title: "Old row", outcome: undefined, evidence: undefined })]);
    const row = screen.getByText("Old row").closest("li") as HTMLElement;
    expect(row.querySelector("[data-evidence-class]")).toBeNull();
    expect(row.textContent).not.toMatch(/Completed|Sent|waiting/);
  });
});
