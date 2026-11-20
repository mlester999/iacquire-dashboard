// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ApprovalCenter } from "@/components/approvals/approval-center";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/approvals", () => ({ approvalEventsAction: vi.fn(), decideApprovalAction: vi.fn() }));

afterEach(cleanup);

function approval(agent_role: string) {
  return {
    id: `approval-${agent_role}`,
    kind: "crm_update",
    title: "Review a saved change",
    target_type: null,
    target_label: null,
    reason: "A person needs to review the change.",
    expected_effect: "The approved change will be applied.",
    risk: "medium",
    status: "pending",
    execution_status: "not_started",
    execution_detail: null,
    expires_at: null,
    decided_at: null,
    decision_note: null,
    created_at: "2026-10-24T08:00:00.000Z",
    agent_role,
    requested_by_name: null,
    decided_by_name: null,
    evidence: null,
    outcome: null,
  };
}

function renderApproval(agentRole: string) {
  return render(<ApprovalCenter approvals={[approval(agentRole)] as never} canDecide={false} canDecideHigh={false} timeZone="UTC" />);
}

describe("approval requester identity", () => {
  it("attributes Growth Partner requests to AI Growth Partner and retains legacy names", () => {
    const view = renderApproval("growth_partner");
    const partnerRow = screen.getByText("Review a saved change").closest("li") as HTMLElement;
    expect(within(partnerRow).getByText("AI Growth Partner")).toBeTruthy();
    expect(within(partnerRow).queryByText("System")).toBeNull();
    expect(screen.getByText("Activity and Approvals")).toBeTruthy();

    view.unmount();
    renderApproval("lead_hunter");
    const legacyRow = screen.getByText("Review a saved change").closest("li") as HTMLElement;
    expect(within(legacyRow).getByText("Lead Hunter")).toBeTruthy();
  });
});
