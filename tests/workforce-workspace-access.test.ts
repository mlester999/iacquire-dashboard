import { describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { assertWorkforceWorkspaceAccess } from "@/server/workforce/workspace-access";
import type { OrgContext } from "@/server/tenancy/context";

function context(kind: "agency" | "client", platformRole: "none" | "agency_staff" | "agency_manager" | "agency_super_admin") {
  return {
    org: { kind },
    user: { platformRole },
  } as OrgContext;
}

describe("internal workforce workspace access", () => {
  it("allows only an agency Super Admin in the internal agency workspace", () => {
    expect(assertWorkforceWorkspaceAccess(context("agency", "agency_super_admin"))).toMatchObject({ org: { kind: "agency" } });
    for (const role of ["none", "agency_staff", "agency_manager"] as const) {
      let thrown: unknown;
      try {
        assertWorkforceWorkspaceAccess(context("agency", role));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown).toMatchObject({ code: "forbidden" });
    }
  });

  it("preserves ordinary client workspace access for client users and assigned agency staff", () => {
    expect(assertWorkforceWorkspaceAccess(context("client", "none"))).toMatchObject({ org: { kind: "client" } });
    expect(assertWorkforceWorkspaceAccess(context("client", "agency_staff"))).toMatchObject({ org: { kind: "client" } });
  });
});
