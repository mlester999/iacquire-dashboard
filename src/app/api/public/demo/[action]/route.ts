import { handleDemo } from "@/server/demo/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A chat message waits for the language model (up to 20 seconds) and then for the answer to be checked and stored.
export const maxDuration = 40;

// The prospect demo's public API: asking for a demo, the link's button, the chat, the room's buttons. Same-site only (there is no CORS), bounded, rate limited, and answered with
// no-store headers. The emergency stop DEMO_PUBLIC_DISABLED answers before the body is read. See src/server/demo/http.ts.
async function handle(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  return handleDemo(req, action);
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
