import { beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({
  ctx: null as null | {
    user: { id: string; platformRole: "none" | "agency_staff" | "agency_manager" | "agency_super_admin" };
    org: { orgId: string; kind: "agency" | "client" };
    can: (permission: string) => boolean;
  },
  getWorkJobView: vi.fn(async () => ({ id: "77777777-7777-4777-8777-777777777777" })),
  cancelWorkJob: vi.fn(async () => "cancelled" as const),
  retryWorkJobForUser: vi.fn(async () => undefined),
}));

vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  return {
    ...actual,
    requireOrgContextOrThrow: async () => {
      if (!routeState.ctx) throw new AppError("unauthenticated", "Sign in to continue.");
      return routeState.ctx;
    },
  };
});

vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return { ...actual, assertSameOrigin: async () => undefined };
});

vi.mock("@/server/workforce/jobs", () => ({
  cancelWorkJob: routeState.cancelWorkJob,
  getWorkJobView: routeState.getWorkJobView,
  retryWorkJobForUser: routeState.retryWorkJobForUser,
}));

import { GET, POST } from "@/app/api/work/jobs/[id]/route";

const BASE = "http://localhost/api/work/jobs/77777777-7777-4777-8777-777777777777";
const context = (kind: "agency" | "client", platformRole: "none" | "agency_staff" | "agency_manager" | "agency_super_admin") => ({
  user: { id: "11111111-1111-4111-8111-111111111111", platformRole },
  org: { orgId: "22222222-2222-4222-8222-222222222222", kind },
  can: () => true,
});
const params = { params: Promise.resolve({ id: "77777777-7777-4777-8777-777777777777" }) };

beforeEach(() => {
  routeState.ctx = context("agency", "agency_staff");
  routeState.getWorkJobView.mockClear();
  routeState.cancelWorkJob.mockClear();
  routeState.retryWorkJobForUser.mockClear();
});

describe("internal workforce job endpoint", () => {
  it("blocks agency staff from reading job results or controlling jobs", async () => {
    const read = await GET(new Request(BASE), params);
    const cancel = await POST(new Request(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }), params);
    const retry = await POST(new Request(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry" }) }), params);

    expect(read.status).toBe(403);
    expect(cancel.status).toBe(403);
    expect(retry.status).toBe(403);
    expect(routeState.getWorkJobView).not.toHaveBeenCalled();
    expect(routeState.cancelWorkJob).not.toHaveBeenCalled();
    expect(routeState.retryWorkJobForUser).not.toHaveBeenCalled();
  });

  it("preserves Super Admin internal access and ordinary client workspace access", async () => {
    routeState.ctx = context("agency", "agency_super_admin");
    expect((await GET(new Request(BASE), params)).status).toBe(200);
    expect((await POST(new Request(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }), params)).status).toBe(200);

    routeState.ctx = context("client", "none");
    expect((await GET(new Request(BASE), params)).status).toBe(200);
    expect(routeState.getWorkJobView).toHaveBeenCalledTimes(2);
    expect(routeState.cancelWorkJob).toHaveBeenCalledOnce();
  });
});
