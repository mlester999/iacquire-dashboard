import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilityChecklist } from "@/components/workforce/capability-checklist";
import { deriveCapabilityChecks, type CapabilityInput } from "@/lib/employee-capability-status";

const input: CapabilityInput = {
  configured: true, configVersion: 2, enabled: true, connected: true, runtimeStatus: "online", inventoryVerified: true, inventoryToolCount: 6,
  prerequisitesMet: false, missingPrerequisites: ["A booking calendar"], mode: "approval_required", activity: null, now: new Date("2026-10-28T08:00:00Z"),
};

describe("capability checklist", () => {
  const checks = deriveCapabilityChecks(input);

  it("shows customers one plain sentence per fact and no diagnostics", () => {
    const html = renderToStaticMarkup(<CapabilityChecklist checks={checks} audience="customer" />);
    expect(html).toContain("What this employee can do right now");
    expect(html).toContain("3 of 6 confirmed");
    for (const label of ["Set up", "Connected", "Safe tools confirmed", "Your business setup is ready", "Can read your records", "Changes need your approval", "Has answered a real question", "Allowed to work on its own"]) expect(html).toContain(label);
    expect(html).toContain("Still needed: A booking calendar.");
    expect(html).not.toContain("Configuration version");
    expect(html).not.toContain("Runtime status");
    expect(html).not.toContain("Runtime tool inventory");
  });

  it("gives administrators the evidence behind each line", () => {
    const html = renderToStaticMarkup(<CapabilityChecklist checks={checks} audience="admin" />);
    expect(html).toContain("Configuration version 2 is applied.");
    expect(html).toContain("Runtime status online.");
    expect(html).toContain("No workspace read has been recorded for this employee yet.");
  });

  it("marks only recorded facts as yes and says so for the rest", () => {
    const html = renderToStaticMarkup(<CapabilityChecklist checks={checks} audience="customer" />);
    expect(html).toContain("Not confirmed");
    expect(html).toContain("Not checked yet.");
  });
});
