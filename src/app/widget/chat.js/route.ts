import { WIDGET_SCRIPT } from "@/lib/webchat/widget-script";

export const dynamic = "force-static";

// The embeddable chat script. The same text for everyone and a public file: it carries no secret, and which workspace it serves is decided by the
// `data-key` on the page's own script tag. Cached for a few minutes so a fix reaches installed sites quickly.
export function GET() {
  return new Response(WIDGET_SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
