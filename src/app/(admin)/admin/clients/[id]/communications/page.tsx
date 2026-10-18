import { notFound } from "next/navigation";
import { MessagesSquare } from "lucide-react";
import { requireAgency, agencyCanAccessOrg } from "@/server/tenancy/context";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { listChannelStatus } from "@/server/messaging/channels";
import { twilioWebhookUrl } from "@/server/messaging/transports/twilio";
import { RESEND_REQUIRED_EVENTS } from "@/server/messaging/transports/resend";
import { PageHero } from "@/components/ui/workspace";
import { AgencyChannelSetup } from "@/components/crm/communications/agency-channel-setup";

export const metadata = { title: "Client messaging channels" };
export const dynamic = "force-dynamic";

/**
 * The agency's per-client channel setup: for email, SMS and WhatsApp, which provider carries it (GoHighLevel or iAcquire's own Resend, Twilio,
 * Meta), the sender, the stored credential (only whether one exists), the last capability test, and the controls to change them. Staff assigned
 * to the client can look; only super admins enter credentials or switch channels (the services refuse anyone else).
 */
export default async function ClientCommunicationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const user = await requireAgency();
  if (!(await agencyCanAccessOrg(user, id))) notFound();
  const org = await withSystem((db) => db.query<{ name: string }>("select name from organizations where id = $1 and kind = 'client'", [id]));
  if (!org.rows[0]) notFound();
  const channels = await listChannelStatus(id);
  await recordAudit({ orgId: id, actorUserId: user.id, actorKind: "agency", action: "messaging.channel_setup_viewed", targetType: "organization", targetId: id, result: "success" });
  const e = env();
  const base = e.APP_URL.replace(/\/+$/, "");
  // Where each provider must send its events. Addresses and whether the agency-level secrets are configured: never the secrets themselves.
  const webhooks = {
    email: {
      url: `${base}/api/webhooks/resend`,
      ready: Boolean(e.RESEND_WEBHOOK_SECRET),
      // One webhook in iAcquire's own Resend account serves every client; Resend generates its secret, which this deployment holds.
      note: `Add it once as a webhook in iAcquire's Resend account, with the events ${[...RESEND_REQUIRED_EVENTS, "email.received"].join(", ")}. Resend generates its signing secret, and RESEND_WEBHOOK_SECRET must be that secret.`,
    },
    sms: { url: twilioWebhookUrl("inbound"), ready: true, note: "Set it as the incoming-message webhook on the Messaging Service or number. Delivery reports are requested per message automatically." },
    whatsapp: {
      url: `${base}/api/webhooks/meta-whatsapp`,
      ready: Boolean(e.META_APP_SECRET && e.META_WEBHOOK_VERIFY_TOKEN),
      note: "Set it as the callback URL of the iAcquire Meta app, with META_WEBHOOK_VERIFY_TOKEN as the verify token, and subscribe the WhatsApp Business Account to the app.",
    },
  } as const;
  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Client messaging"
        title={org.rows[0].name}
        icon={<MessagesSquare className="size-4" />}
        tone="neutral"
        description="Choose the provider for each channel, store its credential in the vault, test it, then switch it on. Credentials are replace-only: once saved they are never shown again, to anyone."
      />
      <AgencyChannelSetup orgId={id} channels={JSON.parse(JSON.stringify(channels))} webhooks={webhooks} superAdmin={user.platformRole === "agency_super_admin"} timeZone={user.timezone} />
    </div>
  );
}
