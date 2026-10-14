import { beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { withSystem, withUser } from "@/server/db";
import { addMember, agencyUser, createOrg, createUser } from "./support/fixtures";
import { importFounderPortfolio } from "@/server/portfolio/import";
import {
  deletePortfolioAsset, getPortfolioImage, getPortfolioProject, listPortfolio, listPortfolioForAdmin, reviewPortfolioProject, savePortfolioProject,
  updatePortfolioAsset, uploadPortfolioAsset, importAssetFromSource,
} from "@/server/portfolio/service";
import { listMarketplaceServices } from "@/server/catalog/service";
import { portfolioTitle } from "@/lib/projects";

let client: { id: string; email: string };
let superAdmin: ReturnType<typeof agencyUser>;
let staff: ReturnType<typeof agencyUser>;
const slugs = [
  "homeveal-bathroom-remodeling-ai-lead-to-appointment-system", "aivanza-academy-ai-learning-platform-admin-portal", "tony-ai-trainable-negotiation-conversation-platform",
  "zorivelle-realty-chatbot-rag-powered-document-q-a", "ai-email-agent-classification-kb-reply-human-in-the-loop", "4br-guest-follow-up-qr-check-in-conditional-sequences",
  "ai-linkedin-content-publishing-approval-posting-via-slack", "mitchy-dental-lounge-ai-voice-receptionist", "vtl-sleep-spray-custom-shopify-liquid-storefront",
  "avouria-vip-membership-custom-find-my-size-quiz-a-b-testing", "ai-series-masterclass-learning-management-system-for-viral-stories-ph",
];

beforeAll(async () => {
  const org = await createOrg({ name: "Portfolio Viewer Co" });
  client = await createUser();
  await addMember(org.id, client.id, "owner");
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
});

describe("verified portfolio import", () => {
  it("imports exactly the eleven selected founder projects as hidden, pending review", async () => {
    const first = await withSystem((db) => importFounderPortfolio(db, superAdmin.id));
    expect(first.created).toBe(11);
    const admin = await listPortfolioForAdmin(superAdmin);
    expect(admin.projects.map((p) => p.slug).sort()).toEqual([...slugs].sort());
    for (const p of admin.projects) {
      expect(p.reviewState).toBe("pending_review");
      expect(p.visible).toBe(false);
      expect(p.disclosureConfirmed).toBe(false);
      expect(p.attribution).toBe("Selected Work from Our Founder");
      expect(p.sourceUrl).toMatch(/^https:\/\/www\.automatewithmarky\.com\/projects\//);
      // Source statuses are preserved, and results are not turned into fabricated metrics.
      expect(p.status).toBe("built");
      expect(p.publishedOutcome ?? "").not.toMatch(/\d+\s?%|\$\d/);
    }
    // Clients see nothing until an admin reviews and publishes.
    expect(await listPortfolio(client.id)).toEqual([]);
    expect(await getPortfolioProject(client.id, slugs[0])).toBeNull();
  });

  it("is idempotent and never overwrites an approved project", async () => {
    const again = await withSystem((db) => importFounderPortfolio(db, superAdmin.id));
    expect(again.created).toBe(0);
    expect(again.assetsAdded).toBe(0);
    const home = (await listPortfolioForAdmin(superAdmin)).projects.find((p) => p.slug === slugs[0])!;
    await savePortfolioProject(superAdmin, { id: home.id, slug: home.slug, title: home.title, summary: "Edited by an admin.", clientNamePublic: true });
    await reviewPortfolioProject(superAdmin, home.id, "approve_and_publish", { disclosureConfirmed: true });
    const third = await withSystem((db) => importFounderPortfolio(db, superAdmin.id));
    expect(third.untouched).toBe(1);
    expect((await listPortfolioForAdmin(superAdmin)).projects.find((p) => p.id === home.id)!.summary).toBe("Edited by an admin.");
  });

  it("links projects to the services they relate to", async () => {
    const detail = await getPortfolioProject(client.id, slugs[0]);
    expect(detail!.services.map((s) => s.slug)).toContain("lead-capture-qualification");
    const services = await listMarketplaceServices(client.id);
    expect(services.find((s) => s.slug === "lead-capture-qualification")!.portfolio.map((p) => p.slug)).toContain(slugs[0]);
    // Related work on a service only lists published projects.
    expect(services.find((s) => s.slug === "ai-voice-receptionist")!.portfolio).toEqual([]);
  });
});

describe("review gate and disclosure", () => {
  it("only super admins manage the portfolio", async () => {
    const p = (await listPortfolioForAdmin(superAdmin)).projects[0];
    await expect(listPortfolioForAdmin(staff)).rejects.toThrow(/super admins/);
    await expect(reviewPortfolioProject(staff, p.id, "approve_and_publish", { disclosureConfirmed: true })).rejects.toThrow(/super admins/);
    await expect(savePortfolioProject(staff, { slug: "x-y", title: "Nope" })).rejects.toThrow(/super admins/);
  });

  it("publishing requires explicit confirmation that public disclosure is permitted", async () => {
    const p = (await listPortfolioForAdmin(superAdmin)).projects.find((x) => x.slug === slugs[7])!;
    await expect(reviewPortfolioProject(superAdmin, p.id, "approve_and_publish")).rejects.toThrow(/disclosure/);
    // The database enforces it too, even for direct writes.
    await expect(withSystem((db) => db.query("update portfolio_projects set visible = true where id = $1", [p.id]))).rejects.toThrow();
    await reviewPortfolioProject(superAdmin, p.id, "approve_and_publish", { disclosureConfirmed: true });
    const shown = await getPortfolioProject(client.id, slugs[7]);
    expect(shown!.attribution).toBe("Selected Work from Our Founder");
    expect(shown!.limitations.length).toBeGreaterThan(0);
    await reviewPortfolioProject(superAdmin, p.id, "hide");
    expect(await getPortfolioProject(client.id, slugs[7])).toBeNull();
  });

  it("shows an anonymized title unless the client name has been cleared", async () => {
    const p = (await listPortfolioForAdmin(superAdmin)).projects.find((x) => x.slug === slugs[1])!;
    await savePortfolioProject(superAdmin, { id: p.id, slug: p.slug, title: p.title, anonymizedTitle: "AI learning platform and admin portal", clientNamePublic: false });
    await reviewPortfolioProject(superAdmin, p.id, "approve_and_publish", { disclosureConfirmed: true });
    const card = (await listPortfolio(client.id)).find((c) => c.slug === slugs[1])!;
    expect(card.title).toBe("AI learning platform and admin portal");
    expect(card.title).not.toMatch(/AIvanza/);
    expect(portfolioTitle({ title: "Real Name", anonymizedTitle: null, clientNamePublic: false })).toBe("Client project");
  });

  it("pending projects keep their status label; in-development work would be labelled as such", async () => {
    const p = (await listPortfolioForAdmin(superAdmin)).projects.find((x) => x.slug === slugs[2])!;
    await savePortfolioProject(superAdmin, { id: p.id, slug: p.slug, title: p.title, status: "in_development", statusLabel: "In development" });
    await reviewPortfolioProject(superAdmin, p.id, "approve_and_publish", { disclosureConfirmed: true });
    const card = (await listPortfolio(client.id)).find((c) => c.slug === slugs[2])!;
    expect(card.status).toBe("in_development");
    expect(card.statusLabel).toBe("In development");
  });

  it("clients cannot write portfolio data or read unpublished rows", async () => {
    await expect(withUser(client.id, (db) => db.query("update portfolio_projects set featured = true"))).rejects.toThrow(/permission denied/);
    const visible = await withUser(client.id, (db) => db.query<{ visible: boolean }>("select visible from portfolio_projects"));
    expect(visible.rows.every((r) => r.visible)).toBe(true);
  });
});

describe("portfolio images", () => {
  let projectId: string;
  beforeAll(async () => {
    projectId = (await listPortfolioForAdmin(superAdmin)).projects.find((x) => x.slug === slugs[0])!.id;
  });

  it("optimizes uploads to WebP, keeps them private, and serves them only once published", async () => {
    const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#3366ff" } }).png().toBuffer();
    const { id } = await uploadPortfolioAsset(superAdmin, projectId, { name: "My Screenshot.png", bytes: png }, { alt: "Dashboard screenshot", kind: "screenshot" });
    // Unpublished: invisible to clients.
    await expect(getPortfolioImage(client.id, id, "full")).rejects.toThrow(/not found/i);
    expect((await getPortfolioProject(client.id, slugs[0]))!.assets.some((a) => a.id === id)).toBe(false);
    // Admin preview works.
    const preview = await getPortfolioImage(superAdmin.id, id, "full");
    expect(preview.mime).toBe("image/webp");
    await updatePortfolioAsset(superAdmin, id, { published: true });
    const full = await getPortfolioImage(client.id, id, "full");
    const thumb = await getPortfolioImage(client.id, id, "thumb");
    expect(full.mime).toBe("image/webp");
    const fm = await sharp(full.bytes).metadata();
    const tm = await sharp(thumb.bytes).metadata();
    expect(fm.format).toBe("webp");
    expect(fm.width).toBe(1600);
    expect(tm.width).toBe(640);
    expect(full.bytes.length).toBeLessThan(png.length);
    // Stored keys and files are not reachable by clients directly.
    expect((await withUser(client.id, (db) => db.query("select id from private_files where bucket = 'portfolio-assets'"))).rows).toHaveLength(0);
    await expect(withUser(client.id, (db) => db.query("select private_file_id from portfolio_assets"))).rejects.toThrow(/permission denied/);
    await deletePortfolioAsset(superAdmin, id);
    await expect(getPortfolioImage(superAdmin.id, id, "full")).rejects.toThrow(/not found/i);
  });

  it("rejects files that are not images and uploads by non-admins", async () => {
    await expect(uploadPortfolioAsset(superAdmin, projectId, { name: "x.png", bytes: Buffer.from("not an image") }, { alt: "x" })).rejects.toThrow(/image/);
    await expect(uploadPortfolioAsset(staff, projectId, { name: "x.png", bytes: Buffer.from("x") }, { alt: "x" })).rejects.toThrow(/super admins/);
  });

  it("source images are references: admins can preview them, they can't be published or reach clients, and only the approved host is ever fetched", async () => {
    const refAsset = (await listPortfolioForAdmin(superAdmin)).projects.find((x) => x.id === projectId)!.assets.find((a) => a.sourceUrl && !a.stored)!;
    expect(refAsset.published).toBe(false);
    // A linked (unimported) image can never be published, so it can never be shown to a client.
    await expect(updatePortfolioAsset(superAdmin, refAsset.id, { published: true })).rejects.toThrow(/Import a copy or upload/);
    await expect(getPortfolioImage(client.id, refAsset.id, "full")).rejects.toThrow(/not found/i);
    // Staff preview fetches the single referenced image on demand from the approved source host (stubbed here).
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array(png), { status: 200, headers: { "content-type": "image/png" } }));
    const preview = await getPortfolioImage(superAdmin.id, refAsset.id, "full");
    expect(preview.mime).toBe("image/png");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/^https:\/\/www\.automatewithmarky\.com\//);
    // Importing stores an optimized private copy, which can then be published and served to clients.
    await importAssetFromSource(superAdmin, refAsset.id);
    fetchSpy.mockRestore();
    await updatePortfolioAsset(superAdmin, refAsset.id, { published: true });
    const served = await getPortfolioImage(client.id, refAsset.id, "full");
    expect(served.mime).toBe("image/webp");
    // An asset that points at some other host can never be fetched.
    const other = (await listPortfolioForAdmin(superAdmin)).projects.find((x) => x.id === projectId)!.assets.find((a) => a.sourceUrl && !a.stored)!;
    await withSystem((db) => db.query("update portfolio_assets set source_url = 'https://evil.example.com/a.png' where id = $1", [other.id]));
    await expect(importAssetFromSource(superAdmin, other.id)).rejects.toThrow(/approved source/);
    await expect(getPortfolioImage(superAdmin.id, other.id, "full")).rejects.toThrow(/approved source/);
  });
});
