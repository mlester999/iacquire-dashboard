// The realistic workspace used by the AI builder evaluation: it builds, and the builder is shown exactly what it holds.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { loadBuilderOptions } from "@/server/crm/workflows/context";
import { studioWorkspace } from "./support/studio-workspace";

describe("the studio test workspace", () => {
  it("holds approved templates, tags, two pipelines, a calendar and a form, and the builder's options list them", async () => {
    const w = await studioWorkspace();
    const o = await withSystem((db) => loadBuilderOptions(db, w.o.org.id));
    expect(o.tags.map((t) => t.name).sort()).toEqual(["Customer", "Hot", "VIP", "Website lead"]);
    expect(o.templates.map((t) => t.name).sort()).toEqual(["Appointment reminder", "Booking confirmation", "Follow-up check-in"]);
    expect(o.pipelines.map((p) => p.name)).toContain("Installations");
    expect(o.pipelines.find((p) => p.name === "Installations")!.stages.map((s) => s.name)).toEqual(["Quote sent", "Scheduled", "Installed", "Declined"]);
    expect(o.calendars).toHaveLength(1);
    expect(o.appointmentTypes.map((t) => t.name)).toEqual(["On-site estimate"]);
    expect((o.forms ?? []).map((f) => f.name)).toEqual(["Estimate request"]);
    expect(o.agents.length).toBeGreaterThanOrEqual(6);
  });
});
