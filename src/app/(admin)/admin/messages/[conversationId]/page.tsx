import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { isId } from "@/server/staff-messages/access";
import { loadPageData } from "@/server/staff-messages/page-data";
import { MessagesApp } from "@/components/staff-messages/messages-app";
import { MessagesUnavailable } from "@/components/staff-messages/unavailable";
import { parseDeepLink } from "@/lib/staff-messages/view";
import { currentTime } from "@/lib/utils";

export const metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

/**
 * One conversation. The address names it, and nothing more: whether the person may read it is decided from the database on this request, and one they are not in is shown as
 * "not available" in the same words as an address that never existed. `?at=<message number>` opens it around that message (a search hit) and `?thread=<message id>` opens a thread.
 */
export default async function ConversationPage({ params, searchParams }: { params: Promise<{ conversationId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAgency();
  const { conversationId } = await params;
  if (!isId(conversationId)) notFound();
  const link = parseDeepLink(await searchParams);
  const id = conversationId.toLowerCase();
  const data = await loadPageData(user, { conversationId: id, aroundSeq: link.aroundSeq, threadId: link.threadId });
  if (data.kind === "unavailable") return <MessagesUnavailable reason={data.reason} superAdmin={user.platformRole === "agency_super_admin"} />;
  return <MessagesApp key={`${id}:${link.aroundSeq ?? ""}:${link.threadId ?? ""}`} me={data.me} initial={data.initial} conversationId={id} aroundSeq={link.aroundSeq} threadId={link.threadId} now={currentTime()} />;
}
