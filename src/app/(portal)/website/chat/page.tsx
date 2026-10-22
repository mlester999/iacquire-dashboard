import { MessagesSquare } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { PageHero } from "@/components/ui/workspace";
import { readWidgetView } from "@/server/webchat/config";
import { chatOverview } from "@/server/webchat/analytics";
import { env } from "@/server/env";
import { WebChatSettings } from "@/components/website/portal/chat-settings";
import { KNOWLEDGE_SECTIONS } from "@/server/knowledge/service";

export const metadata = { title: "Website chat" };

export default async function WebsiteChatPage() {
  const ctx = await requireOrgContext("website.view");
  const [view, overview] = await Promise.all([readWidgetView(ctx), chatOverview(ctx)]);
  const appOrigin = (() => {
    try {
      return new URL(env().APP_URL ?? "").origin;
    } catch {
      return "";
    }
  })();
  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Website" title="Website chat" icon={<MessagesSquare className="size-4" />} tone="neutral"
        description="Let visitors on your website talk to your AI employee. Every chat is a conversation in your Inbox, and anything a visitor shares is treated as unverified until your team checks it."
      />
      <WebChatSettings
        view={JSON.parse(JSON.stringify(view))}
        overview={JSON.parse(JSON.stringify(overview))}
        appOrigin={appOrigin}
        sections={KNOWLEDGE_SECTIONS.map((s) => ({ key: s.key, label: s.label }))}
      />
    </div>
  );
}
