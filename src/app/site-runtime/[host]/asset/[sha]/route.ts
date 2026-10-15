import { after } from "next/server";
import { headers } from "next/headers";
import { allowedWidth } from "@/lib/website/responsive-image";
import { resizedVariant } from "@/server/sites/image-variants";
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
  // `?w=` asks for a smaller copy at one of a few fixed widths; anything else is served as the original.
  const width = allowedWidth(new URL(req.url).searchParams.get("w"));
  const etag = width ? `"${sha}-w${width}"` : `"${sha}"`;
  const immutable = "public, max-age=31536000, immutable";
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": immutable } });
  const asset = await loadSiteAsset(host, sha);
  if (!asset) return new Response("Not found", { status: 404 });
  const variant = width ? await resizedVariant(sha, asset.bytes, width) : null;
  const body = variant?.bytes ?? asset.bytes;
  after(() => recordUsage(host, body.length));
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": variant?.mimeType ?? asset.mimeType,
      "Content-Length": String(body.length),
      "Cache-Control": immutable,
      ETag: variant ? etag : `"${sha}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
