// AQi may describe and link only to the pages it has been given. Social media is one of them, for the people who may see it.
import { describe, expect, it } from "vitest";
import { matchAqiRoute, pageFor, safeAqiHref, type AqiAccess } from "@/lib/aqi/routes";
import { aqiNavigationFor } from "@/server/aqi/service";
import { socialOrg } from "./support/social";

describe("AQi and the social media pages", () => {
  it("knows the social pages, and the pages under them resolve to the right section", () => {
    expect(matchAqiRoute("/social")).toMatchObject({ label: "Social media", permission: "social.view" });
    expect(matchAqiRoute("/social/approvals")).toMatchObject({ path: "/social/approvals" });
    expect(pageFor("/social/analytics")?.path).toBe("/social"); // longest prefix: the analytics page belongs to the section
    expect(pageFor("/social/posts/abc")?.path).toBe("/social");
  });

  it("offers a link only to a person who may see social media", () => {
    const viewer: AqiAccess = { can: (p) => p === "social.view", agencyRole: null };
    const nobody: AqiAccess = { can: () => false, agencyRole: null };
    expect(safeAqiHref("/social/approvals", viewer)?.path).toBe("/social/approvals");
    expect(safeAqiHref("/social", viewer)?.path).toBe("/social");
    expect(safeAqiHref("/social/approvals", nobody)).toBeNull();
    expect(safeAqiHref("/social", nobody)).toBeNull();
  });

  it("keeps the social pages within the routes AQi is given for a person who may open every page", async () => {
    const s = await socialOrg();
    for (const ctx of [s.owner, s.viewer]) {
      const paths = aqiNavigationFor({ can: ctx.can, agencyRole: null } as never).map((r) => r.path);
      expect(paths).toContain("/social");
      expect(paths).toContain("/social/approvals");
    }
    // Adding pages must not push the last ones out of what AQi is given.
    const everything = aqiNavigationFor({ can: () => true, agencyRole: null } as never).map((r) => r.path);
    for (const path of ["/support/requests", "/projects", "/website"]) expect(everything).toContain(path);
    expect(aqiNavigationFor({ can: () => false, agencyRole: null } as never).map((r) => r.path)).not.toContain("/social");
  });
});
