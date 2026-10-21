import { describe, expect, it } from "vitest";
import { isAqiSurface } from "@/lib/aqi/surface";
import { operationsManagerRuntimeNotice } from "@/lib/operations-manager-runtime";
import { ROLE_TOOL_GUIDANCE } from "@/lib/employee-field-guidance";

describe("global AQi surface visibility", () => {
  it.each(["/chat", "/chat/operations-manager", "/chat/lead-hunter"])("hides AQi on %s", (path) => {
    expect(isAqiSurface(path)).toBe(false);
  });

  it.each(["/overview", "/crm/tasks", "/admin/operations"])("keeps AQi on %s", (path) => {
    expect(isAqiSurface(path)).toBe(true);
  });
});

describe("internal Operations Manager capability status", () => {
  it("explains the per-run read-only snapshot and unavailable write actions only for internal Operations Manager chat", () => {
    const notice = operationsManagerRuntimeNotice("operations_manager", "agency");
    expect(notice).toContain("read-only snapshot");
    expect(notice).toContain("not a callable Hermes tool");
    expect(notice).toContain("cannot refresh records mid-run");
    expect(notice).toContain("create or decide approvals");
    expect(notice).toContain("or save summaries");
    expect(ROLE_TOOL_GUIDANCE["tasks.read"].description).toContain("server-authorized, read-only agency task snapshot");
    expect(ROLE_TOOL_GUIDANCE["approvals.create"].description).toContain("no callable approval creation service");
    expect(ROLE_TOOL_GUIDANCE["summaries.write"].description).toContain("no supported workspace service saves operational summaries");
    expect(operationsManagerRuntimeNotice("operations_manager", "client")).toBeNull();
    expect(operationsManagerRuntimeNotice("lead_hunter", "agency")).toBeNull();
  });
});
