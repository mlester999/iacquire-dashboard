import { chatRoute } from "@/server/webchat/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The website chat's public API for an external website. The workspace comes from the public widget key in `?k=` and the browser's Origin must be on that
// widget's allowed list; neither is trusted for anything else (see src/server/webchat/http.ts).
async function handle(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const url = new URL(req.url);
  return chatRoute(req, { kind: "embed", key: url.searchParams.get("k") ?? "", origin: req.headers.get("origin") }, action);
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
