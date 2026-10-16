import { describe, expect, it } from "vitest";
import { statusLabel, statusTone } from "@/components/ui/status";

describe("status vocabulary", () => {
  it("maps common statuses to a tone", () => {
    expect(statusTone("active")).toBe("success");
    expect(statusTone("Connected")).toBe("success");
    expect(statusTone("in_progress")).toBe("primary");
    expect(statusTone("In Progress")).toBe("primary");
    expect(statusTone("pending")).toBe("warning");
    expect(statusTone("waiting-for-client")).toBe("warning");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("blocked")).toBe("danger");
    expect(statusTone("ready_for_review")).toBe("violet");
    expect(statusTone("not_configured")).toBe("neutral");
  });

  it("never turns an unknown, empty or priority-low status into an alarm", () => {
    expect(statusTone("something_new")).toBe("neutral");
    expect(statusTone("")).toBe("neutral");
    expect(statusTone(null)).toBe("neutral");
    expect(statusTone(undefined)).toBe("neutral");
    expect(statusTone("low")).toBe("neutral");
  });

  it("labels statuses in sentence case", () => {
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("waiting-for-client")).toBe("Waiting for client");
    expect(statusLabel("Active")).toBe("Active");
  });
});
