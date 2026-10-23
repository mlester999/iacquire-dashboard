import { handlePdf } from "@/server/proposals/public-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The PDF of the version a customer's link is for, as a download. The token is the only authorization; the file is the link's own version's, never one named by the request.
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handlePdf(req, token);
}
