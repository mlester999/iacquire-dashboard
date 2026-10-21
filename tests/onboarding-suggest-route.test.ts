import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/onboarding/suggest/route";

const calls = vi.hoisted(() => ({ origin: vi.fn(), context: vi.fn(), suggest: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ assertSameOrigin: calls.origin }));
vi.mock("@/server/tenancy/context", () => ({ requireOrgContextOrThrow: calls.context }));
vi.mock("@/server/onboarding/service", () => ({ suggestOnboardingAnswer: calls.suggest }));

beforeEach(() => { vi.clearAllMocks(); calls.origin.mockResolvedValue(undefined); calls.context.mockResolvedValue({ org: { orgId: "authorized-tenant" } }); calls.suggest.mockResolvedValue({ questionId: "a.description", value: "A draft" }); });
const request = (body: unknown) => new Request("https://portal.test/api/onboarding/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("onboarding suggestion endpoint", () => {
  it("checks origin and authenticated permissions, and forwards cancellation", async () => {
    const req = request({ questionId: "a.description", clarifications: { "b.services": "Property management" } });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(calls.origin).toHaveBeenCalledOnce();
    expect(calls.context).toHaveBeenCalledWith("workspace.manage_profile");
    expect(calls.suggest).toHaveBeenCalledWith({ org: { orgId: "authorized-tenant" } }, "a.description", { clarifications: { "b.services": "Property management" }, regenerate: false }, req.signal);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it.each([{ questionId: "a.description", orgId: "foreign-tenant" }, { questionId: "a.description", clarifications: { a: "x".repeat(801) } }])("rejects tenant overrides or excessive detail", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(calls.suggest).not.toHaveBeenCalled();
  });
  it("bounds request bodies before model invocation", async () => {
    expect((await POST(request({ questionId: "a.description", extra: "x".repeat(5000) }))).status).toBe(413);
    expect(calls.suggest).not.toHaveBeenCalled();
  });
});
