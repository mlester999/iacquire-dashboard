import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyUser, createUser } from "./support/fixtures";
import { saveAqiKnowledge } from "@/server/aqi/service";
import { listAqiKnowledgeReview, listAqiKnowledgeVersions, restoreAqiKnowledgeVersion } from "@/server/aqi/knowledge-documents";

const superAdmin = () => createUser({ platformRole: "agency_super_admin" }).then((user) => agencyUser(user, "agency_super_admin"));

describe("AQi knowledge version history", () => {
  it("captures real prior content, lists it and restores it as a draft without fabricating history", async () => {
    const admin = await superAdmin();
    const title = `History ${Math.random().toString(16).slice(2)}`;
    const created = await saveAqiKnowledge(admin, {
      title,
      category: "Platform overview",
      body: "Original body about Contacts.",
      status: "published",
    });
    let versions = await listAqiKnowledgeVersions();
    const initial = versions.filter((version) => version.entryId === created.id);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ version: 1, body: "Original body about Contacts.", changeNote: "Created", status: "published" });

    const edited = await saveAqiKnowledge(admin, {
      id: created.id,
      title: `${title} edited`,
      category: "Platform overview",
      body: "Updated body about Pipelines.",
      status: "draft",
    });
    expect(edited.version).toBe(2);
    versions = await listAqiKnowledgeVersions();
    const forEntry = versions.filter((version) => version.entryId === created.id);
    expect(forEntry.map((version) => version.version)).toEqual([1]);
    expect(forEntry[0].body).toBe("Original body about Contacts.");

    const restored = await restoreAqiKnowledgeVersion(admin, created.id, forEntry[0].id);
    expect(restored.version).toBe(3);
    const review = (await listAqiKnowledgeReview()).find((entry) => entry.id === created.id)!;
    expect(review).toMatchObject({ body: "Original body about Contacts.", status: "draft", version: 3, lastReviewedAt: null });
    versions = await listAqiKnowledgeVersions();
    const afterRestore = versions.filter((version) => version.entryId === created.id);
    expect(afterRestore.map((version) => version.version).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(afterRestore.find((version) => version.version === 2)?.body).toBe("Updated body about Pipelines.");
    expect(afterRestore.find((version) => version.version === 2)?.changeNote).toMatch(/Before restoring v1/);
  });

  it("refuses history and restore for a non-Super-Admin", async () => {
    const owner = await createUser();
    const manager = agencyUser(owner, "agency_manager");
    await expect(restoreAqiKnowledgeVersion(manager, "00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/Super Admin/i);
  });

  it("does not invent versions for entries that predate history", async () => {
    const { rows } = await withSystem(async (db) => db.query<{ id: string }>(
      `insert into aqi_knowledge_entries (title, category, body, status, source)
       values ($1, 'Platform overview', 'Legacy body', 'published', 'Legacy source') returning id`,
      [`Legacy ${Math.random().toString(16).slice(2)}`],
    ));
    const versions = await listAqiKnowledgeVersions();
    expect(versions.filter((version) => version.entryId === rows[0].id)).toHaveLength(0);
  });
});
