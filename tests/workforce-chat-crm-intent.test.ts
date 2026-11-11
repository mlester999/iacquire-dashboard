import { describe, expect, it } from "vitest";
import { parseWorkforceChatCrmIntent } from "@/lib/workforce-chat-crm-intent";

describe("Growth Partner chat CRM intent", () => {
  it("recognizes one named contact with an identity for duplicate checking", () => {
    expect(parseWorkforceChatCrmIntent("growth_partner", "Add Jamie Lee to our CRM with email jamie@example.com and phone +1 555 0100")).toEqual({
      kind: "create_contact", displayName: "Jamie Lee", email: "jamie@example.com", phone: "+1 555 0100",
    });
    expect(parseWorkforceChatCrmIntent("growth_partner", "Create a new contact named Dana Reyes with email dana@example.com")).toEqual({
      kind: "create_contact", displayName: "Dana Reyes", email: "dana@example.com", phone: null,
    });
  });

  it("asks for identity details instead of guessing who a pronoun refers to", () => {
    expect(parseWorkforceChatCrmIntent("growth_partner", "Add this prospect to CRM")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatCrmIntent("growth_partner", "Add this prospect to CRM with email lead@example.com")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatCrmIntent("growth_partner", "Add Jamie Lee to CRM")).toEqual({ kind: "none" });
  });

  it("recognizes a single opportunity only when its name and existing contact are explicit", () => {
    expect(parseWorkforceChatCrmIntent("growth_partner", 'Create an opportunity called "Roof Replacement" for Jamie Lee worth USD 12,500.50.')).toEqual({
      kind: "create_opportunity", name: "Roof Replacement", contactName: "Jamie Lee", value: 12500.5,
    });
    expect(parseWorkforceChatCrmIntent("growth_partner", "Add a new deal named Kitchen Remodel for existing CRM contact Dana Reyes")).toEqual({
      kind: "create_opportunity", name: "Kitchen Remodel", contactName: "Dana Reyes", value: null,
    });
    expect(parseWorkforceChatCrmIntent("growth_partner", "Create an opportunity for Jamie Lee")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatCrmIntent("growth_partner", "Create an opportunity called Roof Replacement for Jamie Lee worth $1,2")).toMatchObject({ kind: "clarification" });
  });

  it("does not expose CRM creation to legacy employee roles or unrelated requests", () => {
    expect(parseWorkforceChatCrmIntent("sales_assistant", "Create a contact named Dana Reyes with email dana@example.com")).toEqual({ kind: "none" });
    expect(parseWorkforceChatCrmIntent("sales_assistant", "Create an opportunity called Roof Replacement for Jamie Lee")).toEqual({ kind: "none" });
    expect(parseWorkforceChatCrmIntent("growth_partner", "Find ten roofing companies in Florida")).toEqual({ kind: "none" });
  });
});
