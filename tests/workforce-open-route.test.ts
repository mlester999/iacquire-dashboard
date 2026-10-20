// /admin/employees/open switches the Super Admin into the internal agency workspace. The "Manage" action
// must reach the employee configuration screen, not chat; the plain action still opens chat. Only an
// allow-listed employee slug is used, so the query string cannot redirect somewhere else.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  requireAgency: vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111" })),
  ensureAgencyPortalAccess: vi.fn(async () => ({ id: "22222222-2222-4222-8222-222222222222", name: "iAcquire", slug: "iacquire" })),
}));

vi.mock("@/server/tenancy/context", () => ({ requireAgency: state.requireAgency }));
vi.mock("@/server/workforce/agency-portal", () => ({ ensureAgencyPortalAccess: state.ensureAgencyPortalAccess }));

import { GET } from "@/app/(admin)/admin/employees/open/route";

function open(query: string) {
  return GET(new Request(`http://localhost/admin/employees/open${query}`));
}

beforeEach(() => {
  state.requireAgency.mockClear();
  state.ensureAgencyPortalAccess.mockClear();
});

describe("the internal workforce open route", () => {
  it("opens the employee configuration page for Manage, after switching into the agency workspace", async () => {
    const res = await open("?role=sales-assistant&to=manage");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/employees/sales-assistant?tab=configure");
    expect(state.requireAgency).toHaveBeenCalledWith("super_admin");
    expect(state.ensureAgencyPortalAccess).toHaveBeenCalledTimes(1);
  });

  it("still opens chat when no Manage target is requested", async () => {
    const res = await open("?role=lead-hunter");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/chat/lead-hunter");
    expect(state.ensureAgencyPortalAccess).toHaveBeenCalledTimes(1);
  });

  it("falls back to the operations manager for an unknown slug or target", async () => {
    let res = await open("?role=not-a-real-role&to=manage");
    expect(res.headers.get("location")).toBe("http://localhost/employees/operations-manager?tab=configure");

    res = await open("?role=not-a-real-role&to=somewhere-else");
    expect(res.headers.get("location")).toBe("http://localhost/chat/operations-manager");
  });
});
