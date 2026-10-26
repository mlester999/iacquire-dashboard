import { requireAgency } from "@/server/tenancy/context";
import { loadPageData } from "@/server/staff-messages/page-data";
import { MessagesApp } from "@/components/staff-messages/messages-app";
import { MessagesUnavailable } from "@/components/staff-messages/unavailable";
import { currentTime } from "@/lib/utils";

export const metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

/** The list of the person's conversations. Anyone on the agency team gets here; what they see is decided from the database on this request (the module switch, their permission). */
export default async function MessagesPage() {
  const user = await requireAgency();
  const data = await loadPageData(user, { conversationId: null, aroundSeq: null, threadId: null });
  if (data.kind === "unavailable") return <MessagesUnavailable reason={data.reason} superAdmin={user.platformRole === "agency_super_admin"} />;
  return <MessagesApp me={data.me} initial={data.initial} conversationId={null} aroundSeq={null} threadId={null} now={currentTime()} />;
}
