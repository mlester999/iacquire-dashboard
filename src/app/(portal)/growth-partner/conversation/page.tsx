import { redirect } from "next/navigation";
import { PermanentGrowthPartnerConversation } from "@/components/growth-partner/permanent-conversation";
import { getGrowthPartnerConversationPage } from "@/server/ai-growth-partner/service";
import { requireOrgContext } from "@/server/tenancy/context";

export const metadata = { title: "AI Growth Partner" };

export default async function GrowthPartnerConversationPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const { q } = await searchParams;
  const ctx = await requireOrgContext();
  if (ctx.org.kind !== "client") {
    redirect(ctx.user.platformRole === "agency_super_admin" ? "/admin/employees" : ctx.user.platformRole === "agency_staff" ? "/admin/employees/clients" : "/no-workspace");
  }

  const conversation = await getGrowthPartnerConversationPage(ctx);
  const initial = conversation ? {
    conversation: {
      ...conversation.conversation,
      lastMessageAt: conversation.conversation.lastMessageAt?.toISOString() ?? null,
      createdAt: conversation.conversation.createdAt.toISOString(),
    },
    messages: conversation.messages.map((message) => ({ ...message, createdAt: message.createdAt.toISOString() })),
    hasMore: conversation.hasMore,
  } : null;

  return <PermanentGrowthPartnerConversation initial={initial} initialInput={typeof q === "string" ? q.slice(0, 2000) : undefined} timeZone={ctx.org.timezone} nowIso={new Date().toISOString()} />;
}
