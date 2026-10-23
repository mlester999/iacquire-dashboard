import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requestMeta } from "@/server/auth/session";
import { loadPublicProposal } from "@/server/proposals/public";
import { looksLikeProposalToken, sessionCookieName } from "@/server/proposals/link-token";
import { noticeFor, PublicProposal } from "@/components/proposals/public/public-proposal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your proposal", robots: { index: false, follow: false }, referrer: "no-referrer" };

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Where a customer lands from a proposal link. The token in the address is the only credential: the business, the proposal and the version are read from the link's own row.
 * Opening the page counts as "opened" (a scanner can do that too); answering needs the emailed code. Everything works without JavaScript except the "viewed" beacon, which is
 * the point of it.
 */
export default async function ProposalPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ r?: string | string[]; c?: string | string[]; left?: string | string[] }> }) {
  const { token } = await params;
  const q = await searchParams;
  const meta = await requestMeta();
  const jar = await cookies();
  const view = await loadPublicProposal(token, {
    ip: meta.ip,
    userAgent: meta.userAgent,
    sessionToken: looksLikeProposalToken(token) ? jar.get(sessionCookieName(token))?.value ?? null : null,
  });
  return <PublicProposal token={token} view={view} result={noticeFor("r", one(q.r))} code={noticeFor("c", one(q.c), one(q.left))} />;
}
