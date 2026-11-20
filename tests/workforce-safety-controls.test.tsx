
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkforceSafetyControls } from "@/components/workforce/safety-controls";

vi.mock("@/components/workforce/operating-controls", () => ({ EmergencyControls: () => null }));

const noPauses = { messagingPaused: false, outboundPaused: false, agencyPaused: false, canPause: false };

describe("workforce safety controls", () => {
  it("shows a server-wide outbound stop even when there are no workspace or agency pauses", () => {
    const html = renderToStaticMarkup(<WorkforceSafetyControls {...noPauses} />);

    expect(html).toContain("Outbound stopped");
    expect(html).toContain("Outbound customer messaging is disabled across this environment.");
    expect(html).toContain("Workspace and agency pauses apply separately.");
    expect(html).not.toContain("No active pauses");
  });

  it("reports workspace and agency pauses independently when the master is enabled", () => {
    const view = (overrides: Partial<typeof noPauses> = {}) => renderToStaticMarkup(
      <WorkforceSafetyControls {...noPauses} {...overrides} outboundMessagingEnabled />,
    );

    expect(view()).toContain("No active pauses");
    expect(view()).not.toContain("Outbound stopped");
    expect(view({ outboundPaused: true })).toContain("Workspace pause");
    expect(view({ agencyPaused: true })).toContain("Agency pause");
  });
});
