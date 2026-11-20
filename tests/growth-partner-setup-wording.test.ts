import { describe, expect, it } from "vitest";
import { currentSetupCopy } from "@/lib/setup-copy";

describe("Growth Partner setup wording", () => {
  it("updates the seeded company-information and calendar descriptions at presentation time", () => {
    expect(currentSetupCopy({
      key: "company_info",
      title: "Company information submitted",
      clientTitle: null,
      description: "The details you shared about your business, goals and how your AI team should communicate.",
      completionNotice: "Company information received",
      clientAction: null,
    }).description).toBe("The details you shared about your business, goals and how AI should support your work.");

    expect(currentSetupCopy({
      key: "calendar",
      title: "Google Calendar connected and appointment availability checked",
      clientTitle: "Google Calendar connected",
      description: "We connect the calendar you already use (Google, Microsoft 365, CalDAV or a calendar feed), or set up your iAcquire calendar, so your AI Appointment Setter only offers times that are really free.",
      completionNotice: null,
      clientAction: null,
    }).description).toBe("We connect the calendar you already use (Google, Microsoft 365, CalDAV or a calendar feed), or set up your iAcquire calendar, so your AI Growth Partner only offers times that are really free.");
  });

  it("presents a legacy completion notice without rewriting the saved snapshot", () => {
    const snapshot = {
      key: "ai_employees",
      title: "Six client-specific Hermes AI employees configured",
      clientTitle: "Your six AI employees are configured",
      description: "Each AI employee gets its own private environment and is checked live before it is marked ready.",
      completionNotice: "Your AI team is ready",
      clientAction: null,
    };

    expect(currentSetupCopy(snapshot)).toMatchObject({
      clientTitle: "Your AI runtime setup",
      completionNotice: "Your AI workspace is ready",
    });
    expect(snapshot.completionNotice).toBe("Your AI team is ready");
  });
});
