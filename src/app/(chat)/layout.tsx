import { requireOrgContext } from "@/server/tenancy/context";
import { getShellData } from "@/server/queries/shell";
import { ChatFrame } from "@/components/chat/chat-frame";

export const dynamic = "force-dynamic";

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext("agents.use");
  const data = await getShellData(ctx);
  return <ChatFrame data={data}>{children}</ChatFrame>;
}
