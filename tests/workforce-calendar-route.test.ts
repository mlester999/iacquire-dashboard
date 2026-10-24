import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const routeState = vi.hoisted(() => ({
  ctx: null as null | import("@/server/tenancy/context").OrgContext,
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

import { GET } from "@/app/api/workforce/calendar/route";
import { createOrg, createUser, ctxFor, addMember } from "./support/fixtures";

const BASE = "http://localhost/api/workforce/calendar";
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };

beforeAll(async () => {
  org = await createOrg({ name: "Calendar Route Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  routeState.ctx = ctxFor(owner, org, "owner");
}, 60000);

beforeEach(() => {
  routeState.ctx = ctxFor(owner, org, "owner");
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
});

describe("workforce calendar endpoint", () => {
  it("requires explicit timezone-aware ISO dates before resolving workspace data", async () => {
    const invalidDate = await GET(new Request(`${BASE}?from=2027-02-30T00:00:00Z&to=2027-03-01T00:00:00Z`));
    expect(invalidDate.status).toBe(400);
    expect((await invalidDate.json()).code).toBe("invalid_input");
    const missingDate = await GET(new Request(`${BASE}?from=2027-03-01`));
    expect(missingDate.status).toBe(400);
    expect(missingDate.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns a private no-store calendar response for a valid authorized range", async () => {
    const response = await GET(new Request(
      `${BASE}?from=2027-03-14T00:00:00-04:00&to=2027-03-21T00:00:00-04:00`,
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      calendar: {
        timezone: "UTC",
        operatorEnabled: false,
        jobs: [],
        schedules: [],
      },
    });
  });

  it("keeps authentication and the server-side maximum range in force", async () => {
    routeState.ctx = null;
    const unauthenticated = await GET(new Request(`${BASE}?from=2027-03-14T00:00:00Z&to=2027-03-15T00:00:00Z`));
    expect(unauthenticated.status).toBe(401);

    routeState.ctx = ctxFor(owner, org, "owner");
    const oversized = await GET(new Request(`${BASE}?from=2027-01-01T00:00:00Z&to=2027-04-01T00:00:00Z`));
    expect(oversized.status).toBe(400);
    expect((await oversized.json()).code).toBe("invalid_input");
  });
});
