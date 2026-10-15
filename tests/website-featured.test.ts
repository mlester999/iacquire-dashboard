import { describe, expect, it } from "vitest";
import { createUser, agencyUser } from "./support/fixtures";
import { withSystem } from "@/server/db";
import { createTemplate, listLibrary, listPublishedCards, setTemplateStatus, updateTemplateMeta } from "@/server/websites/templates";

describe("durable agency template curation", () => {
  it("keeps a built-in template discoverable by industry after its first curation", async () => {
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const key = "meridian.estate";
    const original = (await listLibrary(admin)).find((t) => t.key === key)!;
    expect(original.industries).toContain("real-estate");
    try {
      await updateTemplateMeta(admin, key, { featured: true });
      expect((await listLibrary(admin)).find((t) => t.key === key)?.industries).toEqual(original.industries);
      const published = (await listPublishedCards()).find((t) => t.key === key)!;
      expect(published.featured).toBe(true);
      expect(published.industries).toEqual(original.industries);
      await updateTemplateMeta(admin, key, { featured: false });
      expect((await listPublishedCards()).find((t) => t.key === key)?.featured).toBe(false);
    } finally {
      await withSystem((db) => db.query("delete from website_templates where key = $1 and kind = 'builtin'", [key]));
    }
  });

  it("persists explicit featured choices, enforces permissions and respects publication", async () => {
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const designer = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    const client = { ...designer, platformRole: "none" as const };
    const created = await createTemplate(admin, { name: "Curation test", from: { kind: "builtin", key: "host.terrace" } });
    try {
      expect((await listLibrary(admin)).find((t) => t.key === created.key)?.featured).toBe(false);
      await expect(updateTemplateMeta(designer, created.key, { featured: true })).rejects.toMatchObject({ code: "forbidden" });
      await expect(updateTemplateMeta(client, created.key, { featured: true })).rejects.toMatchObject({ code: "forbidden" });
      await updateTemplateMeta(admin, created.key, { featured: true });
      const stored = await withSystem(async (db) => (await db.query<{ featured: boolean }>("select featured from website_templates where id = $1", [created.id])).rows[0]);
      expect(stored.featured).toBe(true);
      expect((await listLibrary(admin)).find((t) => t.key === created.key)?.featured).toBe(true);
      expect((await listPublishedCards()).some((t) => t.key === created.key)).toBe(false);
      await setTemplateStatus(admin, created.key, "published");
      expect((await listPublishedCards()).find((t) => t.key === created.key)?.featured).toBe(true);
      await setTemplateStatus(admin, created.key, "hidden");
      expect((await listPublishedCards()).some((t) => t.key === created.key)).toBe(false);
      await updateTemplateMeta(admin, created.key, { featured: false });
      expect((await listLibrary(admin)).find((t) => t.key === created.key)?.featured).toBe(false);
    } finally {
      await withSystem((db) => db.query("delete from website_templates where id = $1", [created.id]));
      // The isolated in-memory database is discarded by Vitest; audit actors remain append-only.
    }
  });
});
