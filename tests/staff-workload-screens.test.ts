import { describe, expect, it } from "vitest";
import { LABEL_TONE, loadTone, percentText, SOURCE_SHORT, workloadItemHref } from "@/lib/staff-workload/screens";
import { LABELS } from "@/lib/staff-workload/labels";
import { WORK_SOURCES } from "@/lib/staff-workload/sources";

// The presentation rules that every workload screen shares: a label has one tone, a link goes to the module that owns the item, and an unset capacity is never shown as 0%.

describe("staff workload presentation", () => {
  it("gives every label a tone, with no label missing", () => {
    expect(Object.keys(LABEL_TONE).sort()).toEqual([...LABELS].sort());
    expect(LABEL_TONE.available).toBe("success");
    expect(LABEL_TONE.critical).toBe("danger");
  });

  it("links each kind of work to the module that owns it, never to a made-up page", () => {
    const org = "11111111-1111-4111-8111-111111111111";
    expect(workloadItemHref("support", "22222222-2222-4222-8222-222222222222", org)).toBe("/admin/support?ticket=22222222-2222-4222-8222-222222222222");
    expect(workloadItemHref("project", "22222222-2222-4222-8222-222222222222", org)).toBe("/admin/projects/22222222-2222-4222-8222-222222222222");
    expect(workloadItemHref("setup_task", "22222222-2222-4222-8222-222222222222", org)).toBe(`/admin/clients/${org}/setup`);
    expect(workloadItemHref("maintenance", "22222222-2222-4222-8222-222222222222", org)).toBe("/admin/maintenance");
    for (const source of WORK_SOURCES) expect(SOURCE_SHORT[source]).toMatch(/^[A-Z]/);
  });

  it("shows a missing capacity or percentage as a dash, not zero", () => {
    expect(percentText(null)).toBe("—");
    expect(percentText(87.4)).toBe("87%");
    expect(loadTone(null)).toBe("primary");
    expect(loadTone(50)).toBe("primary");
    expect(loadTone(85)).toBe("warning");
    expect(loadTone(100)).toBe("danger");
    expect(loadTone(140)).toBe("danger");
  });
});
