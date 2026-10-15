import { describe, expect, it } from "vitest";
import { adminDetailLabel } from "@/lib/admin-breadcrumb";
describe("agency route breadcrumbs", () => {
  it("identifies studio collections, designers and editors", () => {
    expect(adminDetailLabel("/admin/website-studio/templates")).toBe("Template Library");
    expect(adminDetailLabel("/admin/website-studio/templates/template-id")).toBe("Template Designer");
    expect(adminDetailLabel("/admin/website-studio/websites")).toBe("Client Websites");
    expect(adminDetailLabel("/admin/website-studio/websites/org-id/edit")).toBe("Website Editor");
    expect(adminDetailLabel("/admin/website-studio/domains")).toBe("Domains & Hosting");
    expect(adminDetailLabel("/admin/clients/org-id")).toBe("Client detail");
    expect(adminDetailLabel("/admin/website-studio")).toBeNull();
  });
});
