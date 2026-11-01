// @vitest-environment jsdom
// The client page's Reviews tab: a waiting section edit, a held employee note and a flagged document each get Approve and Reject, wired to the decision for that item and that client; a
// person who may not decide sees them disabled; a document held before its text was kept can only be rejected. The actions are fakes; nothing here reaches a server.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const actions = vi.hoisted(() => {
  const ok = () => vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
  return {
    decideHeldKnowledgeAction: ok(), decideHeldEmployeeNoteAction: ok(), decideHeldDocumentAction: ok(),
    // The rest of what the page imports, never used here.
    decideHeldVersionAction: ok(), assignStaffAction: ok(), connectHermesAction: ok(), healthCheckAction: ok(), inviteClientUserAction: ok(), provisioningBundleAction: ok(),
    requeueProvisioningAction: ok(), revokeInvitationAction: ok(), setAgentEnabledAction: ok(), setGhlMappingAction: ok(), setTenantStatusAction: ok(),
    syncGhlAction: ok(), updateBillingAction: ok(), updateProvisioningJobAction: ok(), updateUsageLimitsAction: ok(), verifyGhlAction: ok(),
  };
});
vi.mock("@/app/(admin)/admin/actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/admin/clients/o1" }));
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

import { ReviewsTab } from "@/components/admin/client-detail";
import type { TenantDetail } from "@/server/admin/queries";

const ORG = "11111111-1111-4111-8111-111111111111";
const at = new Date("2026-10-26T10:00:00.000Z");
function detail(over: Partial<TenantDetail> = {}): TenantDetail {
  return {
    org: { id: ORG },
    heldVersions: [],
    heldKnowledge: [{ section: "policies", content: "A waiting edit about refunds.", risk_flags: ["prompt_injection"], updated_at: at }],
    heldNotes: [{ id: "note-1", agent_id: "a1", agent_role: "sales_assistant", title: "Discount rule", content: "A held note.", risk_flags: ["prompt_injection"], updated_at: at }],
    heldDocuments: [
      { id: "doc-1", filename: "price-list.txt", scope: "shared", agent_role: null, held_text: "Held document text.", risk_flags: ["prompt_injection"], created_at: at },
      { id: "doc-old", filename: "old-held.txt", scope: "assigned", agent_role: "operations_manager", held_text: null, risk_flags: ["prompt_injection"], created_at: at },
    ],
    contentAccess: { sessionRequired: false, hasSession: false, permitted: true, heldKnowledgeHidden: 0, runDetailsHidden: 0 },
    ...over,
  } as unknown as TenantDetail;
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
});
afterEach(cleanup);

const cardOf = (title: RegExp) => screen.getByText(title).closest("div")!.parentElement as HTMLElement;

describe("the Reviews tab", () => {
  it("wires each item's Approve and Reject to its own decision for this client", async () => {
    render(<ReviewsTab data={detail()} timeZone="UTC" canDecide />);

    fireEvent.click(within(cardOf(/Knowledge · Policies/)).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(actions.decideHeldKnowledgeAction).toHaveBeenCalledWith(ORG, "policies", true));
    fireEvent.click(within(cardOf(/Knowledge · Policies/)).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(actions.decideHeldKnowledgeAction).toHaveBeenCalledWith(ORG, "policies", false));

    fireEvent.click(within(cardOf(/Employee note · .*Discount rule/)).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(actions.decideHeldEmployeeNoteAction).toHaveBeenCalledWith(ORG, "note-1", false));
    fireEvent.click(within(cardOf(/Employee note · .*Discount rule/)).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(actions.decideHeldEmployeeNoteAction).toHaveBeenCalledWith(ORG, "note-1", true));

    fireEvent.click(within(cardOf(/Document · price-list\.txt/)).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(actions.decideHeldDocumentAction).toHaveBeenCalledWith(ORG, "doc-1", true));
    fireEvent.click(within(cardOf(/Document · price-list\.txt/)).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(actions.decideHeldDocumentAction).toHaveBeenCalledWith(ORG, "doc-1", false));
    expect(screen.getByText("Held document text.")).toBeTruthy();
    expect(screen.getByText("Shared with every employee")).toBeTruthy();
  });

  it("lets a document held before its text was kept be rejected only, and says why", async () => {
    render(<ReviewsTab data={detail()} timeZone="UTC" canDecide />);
    const card = cardOf(/Document · old-held\.txt/);
    expect(within(card).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
    expect(within(card).getByRole("button", { name: "Reject" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/held before its text was kept for review/)).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(actions.decideHeldDocumentAction).not.toHaveBeenCalled();
  });

  it("disables every decision for a person who may not decide", () => {
    render(<ReviewsTab data={detail()} timeZone="UTC" canDecide={false} />);
    const buttons = screen.getAllByRole("button").filter((b) => /^(Approve|Reject)$/.test(b.textContent ?? ""));
    expect(buttons).toHaveLength(8);
    expect(buttons.every((b) => b.hasAttribute("disabled"))).toBe(true);
    for (const b of buttons) fireEvent.click(b);
    expect(actions.decideHeldKnowledgeAction).not.toHaveBeenCalled();
    expect(actions.decideHeldEmployeeNoteAction).not.toHaveBeenCalled();
    expect(actions.decideHeldDocumentAction).not.toHaveBeenCalled();
  });

  it("says the queue is clear only when nothing is held and nothing is hidden, and counts what the support-session rule hides", () => {
    const empty = { heldKnowledge: [], heldNotes: [], heldDocuments: [] };
    const { unmount } = render(<ReviewsTab data={detail(empty)} timeZone="UTC" canDecide />);
    expect(screen.getByText("The review queue is clear.")).toBeTruthy();
    unmount();
    render(<ReviewsTab data={detail({ ...empty, contentAccess: { sessionRequired: true, hasSession: false, permitted: false, heldKnowledgeHidden: 3, runDetailsHidden: 0 } })} timeZone="UTC" canDecide />);
    expect(screen.queryByText("The review queue is clear.")).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Approve" })).toHaveLength(0);
  });
});
