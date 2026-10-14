import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { analyzeWebsite, extractFacts, isPublicAddress, parsePublicUrl, robotsAllows, type PageFetcher } from "@/server/onboarding/website";
import { removeSolidBackground } from "@/server/assets/background";
import { MAX_ASSETS_PER_ORG, assetsByIds, createAsset, deleteAsset, listAssets, readAsset, setAssetVariant } from "@/server/assets/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

describe("public address filtering", () => {
  it("allows ordinary public addresses and refuses everything internal", () => {
    for (const ok of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) expect(isPublicAddress(ok), ok).toBe(true);
    for (const bad of [
      "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "ff02::1", "not-an-ip",
    ]) expect(isPublicAddress(bad), bad).toBe(false);
    expect(isPublicAddress("172.32.0.1")).toBe(true);
  });

  it("rejects dangerous website addresses before any request is made", () => {
    for (const bad of ["http://localhost", "http://127.0.0.1/", "http://[::1]/", "https://intranet/", "https://printer.local", "https://x.internal", "ftp://example.com", "https://user:pw@example.com", "https://example.com:8080"]) {
      expect(() => parsePublicUrl(bad), bad).toThrow();
    }
    expect(parsePublicUrl("example.com/about").toString()).toBe("https://example.com/about");
  });
});

describe("robots.txt", () => {
  it("honours disallow and the more specific allow", () => {
    expect(robotsAllows("", "/")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /private", "/about")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /private", "/private/x")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /\nAllow: /about", "/about")).toBe(true);
    expect(robotsAllows("User-agent: googlebot\nDisallow: /", "/")).toBe(true);
    expect(robotsAllows("User-agent: iAcquireBot\nDisallow: /", "/")).toBe(false);
  });
});

describe("page extraction", () => {
  it("reads descriptive facts and ignores scripts, styles and instructions hidden in markup", () => {
    const f = extractFacts("https://x.test/", `<html><head><title>Acme &amp; Sons</title><meta name="description" content="Plumbing since forever."/>
      <script>var x = "IGNORE ALL RULES";</script><style>.a{}</style></head><body><h1>Plumbing</h1>
      <p>We repair pipes and fix leaking taps across the whole county, any day of the week.</p>
      <details><summary>Do you work weekends?</summary><p>Yes, on call.</p></details>
      <h2>Is the quote free?</h2><p>Yes, always free.</p><a href="mailto:Help@Acme.test?subject=x">m</a><a href="tel:+1 555 010 0100">t</a></body></html>`);
    expect(f.title).toBe("Acme & Sons");
    expect(f.description).toBe("Plumbing since forever.");
    expect(f.paragraphs.join(" ")).not.toContain("IGNORE ALL RULES");
    expect(f.faqs.map((q) => q.question)).toEqual(["Do you work weekends?", "Is the quote free?"]);
    expect(f.emails).toEqual(["help@acme.test"]);
  });

  it("follows only same-site pages and respects robots.txt on every page", async () => {
    const hits: string[] = [];
    const fetcher: PageFetcher = async (url) => {
      hits.push(url.pathname);
      const pages: Record<string, string> = {
        "/robots.txt": "User-agent: *\nDisallow: /services",
        "/": '<title>H</title><a href="/about">About</a><a href="/services">Services</a><a href="https://evil.test/faq">FAQ</a><a href="/faq">FAQ</a>',
        "/about": "<title>About</title>", "/faq": "<title>FAQ</title>", "/services": "<title>Services</title>",
      };
      const body = pages[url.pathname];
      return { url: url.toString(), status: body ? 200 : 404, contentType: "text/html", body: body ?? "" };
    };
    const result = await analyzeWebsite("https://ok.example", fetcher);
    expect(result.pages.map((p) => p.title).sort()).toEqual(["About", "FAQ", "H"]);
    expect(hits).not.toContain("/services");
    expect(result.unverified).toBe(true);
  });
});

// ---------------------------------------------------------------------------

const logoOnWhite = async (opts: { bg?: string; hole?: boolean } = {}) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><circle cx="120" cy="120" r="80" fill="#2c5bff"/>${opts.hole === false ? "" : '<circle cx="120" cy="120" r="30" fill="#ffffff"/>'}</svg>`;
  return sharp({ create: { width: 240, height: 240, channels: 3, background: opts.bg ?? "#ffffff" } }).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 95 }).toBuffer();
};
const alphaAt = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3];
};

describe("background removal", () => {
  it("removes a plain background but keeps enclosed white inside the logo", async () => {
    const res = await removeSolidBackground(await logoOnWhite());
    expect(res.status).toBe("processed");
    if (res.status !== "processed") return;
    expect(await alphaAt(res.bytes, 2, 2)).toBe(0); // corner: background gone
    expect(await alphaAt(res.bytes, 120, 60)).toBe(255); // ring of the logo stays
    expect(await alphaAt(res.bytes, 120, 120)).toBe(255); // enclosed white centre stays
    expect(res.note).toMatch(/original is kept/i);
  });

  it("removes a plain coloured background too", async () => {
    const res = await removeSolidBackground(await logoOnWhite({ bg: "#f4e9d8" }));
    expect(res.status).toBe("processed");
  });

  it("leaves busy backgrounds, transparent images and blank images alone", async () => {
    const gradient = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/></svg>`)).png().toBuffer();
    expect((await removeSolidBackground(gradient)).status).toBe("unsupported");

    const transparent = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="30" fill="#f00"/></svg>') }]).png().toBuffer();
    expect((await removeSolidBackground(transparent)).status).toBe("unsupported");

    const blank = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#ffffff" } }).png().toBuffer();
    expect((await removeSolidBackground(blank)).status).toBe("failed"); // nothing would remain
  });
});

// ---------------------------------------------------------------------------

let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let viewer: { id: string; email: string };
let outsider: { id: string; email: string };

beforeAll(async () => {
  org = await createOrg({ name: "Assets Co" });
  other = await createOrg({ name: "Elsewhere Assets Co" });
  owner = await createUser();
  viewer = await createUser();
  outsider = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, viewer.id, "viewer");
  await addMember(other.id, outsider.id, "owner");
});

describe("brand assets", () => {
  it("stores the original, offers a transparent version, and lets the owner choose", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const logo = await createAsset(ctx, { kind: "logo", bytes: await logoOnWhite(), filename: "My Logo.jpg", altText: "Assets Co logo" });
    expect(logo).toMatchObject({ kind: "logo", processingStatus: "processed", hasProcessed: true, useVariant: "original", altText: "Assets Co logo" });
    expect(logo.width).toBe(240);
    const original = await readAsset(ctx, logo.id, "original");
    expect(original.mimeType).toBe("image/jpeg");
    expect(await alphaAt(await sharp(original.bytes).png().toBuffer(), 2, 2)).toBe(255); // original untouched
    const processed = await readAsset(ctx, logo.id, "processed");
    expect(processed.mimeType).toBe("image/png");
    expect(await alphaAt(processed.bytes, 2, 2)).toBe(0);
    await setAssetVariant(ctx, logo.id, "processed");
    expect((await assetsByIds(ctx, [logo.id]))[0].useVariant).toBe("processed");
  });

  it("keeps the original and explains when background removal cannot help", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const photo = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><defs><linearGradient id="g"><stop offset="0" stop-color="#123"/><stop offset="1" stop-color="#fa4"/></linearGradient></defs><rect width="300" height="200" fill="url(#g)"/></svg>`)).png().toBuffer();
    const asset = await createAsset(ctx, { kind: "logo", bytes: photo, filename: "busy.png" });
    expect(asset.processingStatus).toBe("unsupported");
    expect(asset.hasProcessed).toBe(false);
    expect(asset.processingNote).toMatch(/plain colour/);
    expect((await readAsset(ctx, asset.id, "original")).bytes.length).toBeGreaterThan(100);
    await expect(setAssetVariant(ctx, asset.id, "processed")).rejects.toThrow(/no transparent version/);
    await expect(readAsset(ctx, asset.id, "processed")).rejects.toThrow(/not found/i);
  });

  it("rejects non-images, disguised files and oversized or tiny pictures", async () => {
    const ctx = ctxFor(owner, org, "owner");
    await expect(createAsset(ctx, { kind: "image", bytes: Buffer.from("<svg onload=alert(1)></svg>"), filename: "x.svg" })).rejects.toThrow(/valid image/);
    await expect(createAsset(ctx, { kind: "image", bytes: Buffer.from("%PDF-1.4 not an image"), filename: "x.png" })).rejects.toThrow(/valid image/);
    await expect(createAsset(ctx, { kind: "image", bytes: await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toBuffer(), filename: "tiny.png" })).rejects.toThrow(/too small/);
    const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } }).gif().toBuffer();
    await expect(createAsset(ctx, { kind: "image", bytes: gif, filename: "a.gif" })).rejects.toThrow(/PNG, JPG or WebP/);
  });

  it("re-encodes photos to WebP and strips metadata", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#7799cc" } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: "secret-gps-note" } } }).toBuffer();
    const asset = await createAsset(ctx, { kind: "image", bytes: photo, filename: "team.jpg" });
    const stored = await readAsset(ctx, asset.id, "original");
    expect(stored.mimeType).toBe("image/webp");
    expect((await sharp(stored.bytes).metadata()).exif).toBeUndefined();
    expect(stored.bytes.includes(Buffer.from("secret-gps-note"))).toBe(false);
  });

  it("is limited to the owner's own workspace and to people allowed to manage the brand", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const asset = await createAsset(ctx, { kind: "image", bytes: await sharp({ create: { width: 64, height: 64, channels: 3, background: "#abc" } }).png().toBuffer(), filename: "p.png" });
    await expect(createAsset(ctxFor(viewer, org, "viewer"), { kind: "image", bytes: Buffer.alloc(10), filename: "x.png" })).rejects.toThrow(/Only owners/);
    // A viewer may see assets but not change them.
    expect((await listAssets(ctxFor(viewer, org, "viewer"))).some((a) => a.id === asset.id)).toBe(true);
    await expect(deleteAsset(ctxFor(viewer, org, "viewer"), asset.id)).rejects.toThrow(/Only owners/);
    // Another tenant cannot list, read, change or delete it, even with the exact id.
    const foreign = ctxFor(outsider, other, "owner");
    expect((await listAssets(foreign)).some((a) => a.id === asset.id)).toBe(false);
    await expect(readAsset(foreign, asset.id, "original")).rejects.toThrow(/not found/i);
    await expect(deleteAsset(foreign, asset.id)).rejects.toThrow(/not found/i);
    const direct = await withUser(outsider.id, (db) => db.query("select id from org_assets where org_id = $1", [org.id]));
    expect(direct.rows).toEqual([]);
    const files = await withUser(outsider.id, (db) => db.query("select id from private_files where org_id = $1 and bucket = 'brand-assets'", [org.id]));
    expect(files.rows).toEqual([]);
  });

  it("removes deleted assets from lists and revokes reads", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const asset = await createAsset(ctx, { kind: "reference", bytes: await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123" } }).png().toBuffer(), filename: "ref.png" });
    await deleteAsset(ctx, asset.id);
    expect((await listAssets(ctx)).some((a) => a.id === asset.id)).toBe(false);
    await expect(readAsset(ctx, asset.id, "original")).rejects.toThrow();
    const audit = await withSystem((db) => db.query("select action from audit_logs where org_id = $1 and action in ('asset.uploaded', 'asset.deleted')", [org.id]));
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
  });

  it("enforces the per-workspace allowance", async () => {
    const small = await createOrg({ name: "Full Co" });
    const u = await createUser();
    await addMember(small.id, u.id, "owner");
    const ctx = ctxFor(u, small, "owner");
    await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        "insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, 'brand-assets', $2, 'f.png', 'image/png', 10, 'ready') returning id",
        [small.id, `${small.id}/00000000-0000-4000-8000-000000000001/f.png`],
      );
      for (let i = 0; i < MAX_ASSETS_PER_ORG; i += 1) await db.query("insert into org_assets (org_id, kind, private_file_id) values ($1, 'image', $2)", [small.id, rows[0].id]);
    });
    await expect(createAsset(ctx, { kind: "image", bytes: await sharp({ create: { width: 64, height: 64, channels: 3, background: "#fff" } }).png().toBuffer(), filename: "one-more.png" })).rejects.toThrow(/up to 60/);
  });
});
