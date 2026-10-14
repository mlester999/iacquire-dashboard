import { after } from "next/server";
import { headers } from "next/headers";
import { loadSiteAsset, normalizeHost, recordUsage } from "@/server/sites/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Serves an image that belongs to the live publication of this host. Addresses are the image's own content hash,
 * so a response can be cached forever: new content is a new address.
 */
export async function GET(req: Request, { params }: { params: Promise<{ host: string; sha: string }> }) {
  const { host: hostParam, sha } = await params;
  const host = normalizeHost(decodeURIComponent(hostParam));
  if (!host || (await headers()).get("x-site-host") !== host || !/^[0-9a-f]{64}$/.test(sha)) return new Response("Not found", { status: 404 });
  if (req.headers.get("if-none-match") === `"${sha}"`) return new Response(null, { status: 304, headers: { ETag: `"${sha}"`, "Cache-Control": "public, max-age=31536000, immutable" } });
  const asset = await loadSiteAsset(host, sha);
  if (!asset) return new Response("Not found", { status: 404 });
  after(() => recordUsage(host, asset.bytes.length));
  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${sha}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
