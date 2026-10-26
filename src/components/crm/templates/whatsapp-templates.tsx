"use client";

import * as React from "react";
import { ExternalLink, MessageCircle } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/utils";
import type { WhatsappTemplateView } from "@/server/crm/message-templates";

const PROVIDER_LABEL: Record<WhatsappTemplateView["provider"], string> = { meta_whatsapp: "WhatsApp Business (Meta)", ghl: "GoHighLevel" };

/**
 * A template's state as it matters here: whether it can be sent. The sync records several of Meta's states as "rejected" (disabled,
 * archived, deleted, approved but needing something iAcquire can't send yet) and paused or appealed ones as "pending"; the stored reason says
 * which and who decided, so it is shown as written. Shared by the WhatsApp tab, the template editor's link list and the approval dialog.
 */
export function whatsappTemplateState(t: Pick<WhatsappTemplateView, "status" | "provider" | "usable">): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  if (!t.usable) return { label: "Not usable now", tone: "neutral" };
  if (t.status === "approved") return { label: t.provider === "meta_whatsapp" ? "Approved by Meta" : "Approved", tone: "success" };
  if (t.status === "pending") return { label: "Not sendable yet", tone: "warning" };
  return { label: "Can't be sent", tone: "danger" };
}

/** Why a template can't be used, in one sentence, or null when it can. */
export function whatsappTemplateWhyNot(t: Pick<WhatsappTemplateView, "status" | "provider" | "usable" | "rejectionReason">): string | null {
  if (!t.usable) return `It belongs to ${PROVIDER_LABEL[t.provider]}, which no longer carries this workspace's WhatsApp, so it can't be sent.`;
  if (t.status === "approved") return null;
  return t.rejectionReason ?? (t.status === "pending" ? "Waiting for review." : null);
}
const CATEGORY: Record<string, string> = { marketing: "Marketing", utility: "Utility", authentication: "Authentication" };

/**
 * WhatsApp message templates as Meta knows them, read-only. They are created and submitted in WhatsApp Manager (Meta reviews them there);
 * iAcquire shows what was synced, so a template can be linked to one that is approved.
 */
export function WhatsappTemplates({ items, timeZone, q }: { items: WhatsappTemplateView[]; timeZone: string; q: string }) {
  const term = q.trim().toLowerCase();
  const shown = items.filter((t) => !term || `${t.name} ${t.body}`.toLowerCase().includes(term));
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[14px] leading-relaxed text-muted">
        WhatsApp only delivers your own wording within 24 hours of the customer&apos;s last message. Outside that window it delivers only templates Meta approved.
        Those templates are created and submitted for review in WhatsApp Manager, then appear here with their status. They can&apos;t be edited in iAcquire.
      </p>
      {!shown.length ? (
        <Card>
          <EmptyState
            icon={<MessageCircle className="size-5" />}
            title={items.length ? "Nothing matches" : "No WhatsApp templates synced"}
            description={items.length ? "Try a different search." : "Once WhatsApp is connected and templates are approved in WhatsApp Manager, they're listed here."}
          />
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2" aria-label="WhatsApp templates">
          {shown.map((t) => {
            const s = whatsappTemplateState(t);
            const whyNot = whatsappTemplateWhyNot(t);
            return (
              <li key={t.templateId}>
                <Card className="flex h-full flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-[14px] font-medium text-ink">{t.name}</span>
                    <Badge tone={s.tone}>{s.label}</Badge>
                    {t.category && <Badge>{CATEGORY[t.category] ?? t.category}</Badge>}
                    <span className="text-[12px] text-muted">{t.language}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words rounded-xl bg-surface-2/60 p-3 text-[14px] leading-relaxed text-ink-2">{t.body || "No body text was synced for this template."}</p>
                  {t.variables.length > 0 && (
                    <p className="text-[12px] text-muted">Values: {t.variables.map((v) => `{{${v.position}}} ${v.label}`).join(", ")}</p>
                  )}
                  {whyNot && <p className={t.usable && t.status === "rejected" ? "text-[13px] text-danger-ink" : "text-[13px] text-muted"}>{whyNot}</p>}
                  <p className="mt-auto text-[12px] text-faint">
                    {t.provider === "meta_whatsapp" ? "WhatsApp Business (Meta)" : "Through GoHighLevel"}
                    {t.checkedAt ? ` · checked ${formatDateTime(t.checkedAt, timeZone)}` : ""}
                  </p>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <p className="flex items-center gap-1.5 text-[12px] text-muted"><ExternalLink className="size-3.5" aria-hidden />To add or change one, open WhatsApp Manager in Meta Business Suite, or ask iAcquire to help.</p>
    </div>
  );
}
