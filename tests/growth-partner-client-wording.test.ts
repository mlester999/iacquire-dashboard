import { describe, expect, it } from "vitest";
import { approvalRequestedBody, friendlyChatFailure } from "@/server/chat/service";
import { disconnectedApprovalRunDetail } from "@/server/approvals/service";
import { assertAgentRunnable, AgentRunNotReadyError } from "@/server/integrations/hermes/client";
import { noEnabledCustomerRuntimeNotice } from "@/server/messaging/ingest";
import { awaitingReplyBody } from "@/server/messaging/attention";
import { customerReplyApprovalReasonForRole } from "@/server/messaging/web-chat-send";
import { customerReplyCopy, parseReply } from "@/server/messaging/responder";
import { autonomyReconfirmHref } from "@/server/workforce/service";
import { crossEmployeeBlockersTitle, workforceAttentionTitle } from "@/server/workforce/proactive-review";

const legacyClientWords = /AI employee|This employee|Hermes|Partner Settings/;

describe("Growth Partner customer-facing server wording", () => {
  it("uses the product identity for chat failures and approval notices", () => {
    expect(friendlyChatFailure("start_failed", "growth_partner")).toBe("Your AI Growth Partner couldn't start working on this. Please try again.");
    expect(friendlyChatFailure("connection_lost", "growth_partner")).toBe("The connection to your AI Growth Partner dropped before it finished.");
    expect(friendlyChatFailure("run_failed", "growth_partner")).toBe("Your AI Growth Partner couldn't finish this request.");
    expect(approvalRequestedBody("growth_partner")).toBe("Your AI Growth Partner is waiting for your approval.");
    for (const message of [
      friendlyChatFailure("start_failed", "growth_partner"),
      friendlyChatFailure("connection_lost", "growth_partner"),
      friendlyChatFailure("run_failed", "growth_partner"),
      approvalRequestedBody("growth_partner"),
    ]) expect(message).not.toMatch(legacyClientWords);
  });

  it("describes connection readiness without exposing the vendor", () => {
    expect(() => assertAgentRunnable({
      role_key: "growth_partner",
      enabled: true,
      status: "setup_required",
      active_config_version_id: "version-1",
      hermes_profile_config_version_id: "version-1",
      tool_inventory_digest: "a".repeat(64),
      credential_ready: true,
    })).toThrow("Your AI Growth Partner is still being set up and hasn't passed its connection check yet.");

    try {
      assertAgentRunnable({
        role_key: "growth_partner",
        enabled: true,
        status: "online",
        active_config_version_id: "version-1",
        hermes_profile_config_version_id: "version-1",
        tool_inventory_digest: "a".repeat(64),
        credential_ready: false,
      });
      throw new Error("Expected a readiness error");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRunNotReadyError);
      expect((error as Error).message).toBe("Your AI Growth Partner's saved connection is missing or revoked, so it can't run.");
      expect((error as Error).message).not.toMatch(legacyClientWords);
    }
  });

  it("uses partner wording for customer messaging, approvals, inbox notices and recheck links", () => {
    const partnerMessages = [
      customerReplyApprovalReasonForRole("growth_partner", "message"),
      customerReplyApprovalReasonForRole("growth_partner", "website reply"),
      noEnabledCustomerRuntimeNotice(true),
      awaitingReplyBody(true),
      disconnectedApprovalRunDetail("growth_partner"),
      workforceAttentionTitle(1, true),
      crossEmployeeBlockersTitle(2, true),
      customerReplyCopy("growth_partner", "The AI employee did not answer.", "Your AI Growth Partner did not answer."),
      (parseReply("", "growth_partner") as { reason: string }).reason,
    ];
    expect(autonomyReconfirmHref("growth_partner")).toBe("/growth-partner");
    expect(partnerMessages.every((message) => !legacyClientWords.test(message))).toBe(true);
    expect(partnerMessages).toContain("Your AI Growth Partner isn't switched on for this workspace. Open the conversation to take it or assign it.");
    expect(partnerMessages).toContain("Open the conversation to answer, or let your AI Growth Partner handle it.");
  });

  it("uses neutral fallbacks and preserves previous profile links", () => {
    expect(friendlyChatFailure("run_failed", "sales_assistant")).toBe("The previous role profile couldn't finish this request.");
    expect(approvalRequestedBody("operations_manager")).toBe("A previous role profile is waiting for approval.");
    expect(customerReplyApprovalReasonForRole("sales_assistant", "message")).toContain("The assigned AI profile prepared this message");
    expect(disconnectedApprovalRunDetail("sales_assistant")).toBe("The employee is no longer connected, so the step was not run.");
    expect(noEnabledCustomerRuntimeNotice(false)).toBe("Open the conversation to take it or choose an available assignee.");
    expect(awaitingReplyBody(false)).toBe("Open the conversation to reply or assign it to AI.");
    expect(autonomyReconfirmHref("sales_assistant")).toBe("/employees/sales-assistant");
    expect(workforceAttentionTitle(2, false)).toBe("2 previous AI profiles need attention");
    expect(crossEmployeeBlockersTitle(2, false)).toBe("Blocked work spans 2 employees");
  });
});
