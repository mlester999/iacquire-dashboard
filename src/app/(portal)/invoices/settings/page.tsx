import { Settings2 } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { PageHero } from "@/components/ui/workspace";
import { getInvoiceSettings } from "@/server/invoices/settings";
import { getReminderOverview } from "@/server/invoices/reminders";
import { InvoiceSettingsPanel, RemindersPanel } from "@/components/invoices/settings-panel";

export const metadata = { title: "Invoice settings" };

export default async function InvoiceSettingsPage() {
  const ctx = await requireOrgContext("invoices.view");
  const [settings, overview] = await Promise.all([getInvoiceSettings(ctx), getReminderOverview(ctx)]);
  const canEdit = ctx.can("invoices.settings");
  return (
    <div className="space-y-5">
      <PageHero eyebrow="Sales" title="Invoice settings" icon={<Settings2 className="size-4" />} tone="neutral" description="How your invoices look, how they are numbered, what happens when one is paid, and whether reminders go out. Only the business owner changes these." />
      {/* A key that follows the saved version makes each form start again from what was saved, instead of keeping what was typed before a conflict under the other person's version. */}
      <InvoiceSettingsPanel key={settings.version} settings={settings} canEdit={canEdit} />
      <RemindersPanel key={settings.version} settings={settings} overview={overview} canEdit={canEdit} canSwitchOff={ctx.can("invoices.send") || canEdit} tz={ctx.org.timezone || "UTC"} />
    </div>
  );
}
