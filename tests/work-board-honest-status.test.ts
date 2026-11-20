import { describe, expect, it } from "vitest";
import { isCompletedWork, isPreparedOnlyWork } from "@/lib/work-board-status";

describe("work board completion status", () => {
  it("treats draft proposals and approved-but-unsent work as prepared", () => {
    expect(isPreparedOnlyWork("completed", { class: "proposed_change" })).toBe(true);
    expect(isPreparedOnlyWork("completed", { class: "approved_write" })).toBe(true);
    expect(isCompletedWork("completed", { class: "proposed_change" })).toBe(false);
    expect(isCompletedWork("completed", { class: "approved_write" })).toBe(false);
  });

  it("keeps confirmed actions and read-only results completed", () => {
    expect(isPreparedOnlyWork("completed", { class: "completed_action" })).toBe(false);
    expect(isPreparedOnlyWork("completed", { class: "record_retrieval" })).toBe(false);
    expect(isCompletedWork("completed", { class: "completed_action" })).toBe(true);
    expect(isCompletedWork("completed", { class: "record_retrieval" })).toBe(true);
  });

  it("counts a completed CRM import as done after its approved write", () => {
    expect(isPreparedOnlyWork("completed", { class: "approved_write" }, "crm_lead_import")).toBe(false);
    expect(isCompletedWork("completed", { class: "approved_write" }, "crm_lead_import")).toBe(true);
  });

  it("does not classify unfinished work as completed or as a prepared completion", () => {
    expect(isPreparedOnlyWork("running", { class: "proposed_change" })).toBe(false);
    expect(isCompletedWork("waiting_for_approval", { class: "proposed_change" })).toBe(false);
  });
});
