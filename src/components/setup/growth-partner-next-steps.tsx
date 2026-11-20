
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { LaunchReadiness } from "@/lib/launch-readiness";
import type { Permission } from "@/lib/permissions";
import type { GrowthPartnerControlState } from "@/server/ai-growth-partner/service";

export function GrowthPartnerNextSteps({ partner, readiness, can, scheduledWorkEnabled, paymentCleared }: {
  partner: Pick<GrowthPartnerControlState, "status" | "conversationId">;
  readiness: LaunchReadiness | null;
  can: (permission: Permission) => boolean;
  scheduledWorkEnabled: boolean;
  paymentCleared?: boolean;
}) {
  const runtimeVerified = readiness?.steps.some((step) =>
    step.items.some((item) => item.key === "growth_partner.runtime" && item.state === "done"));
  const ready = partner.status === "configured" && Boolean(partner.conversationId) && runtimeVerified && paymentCleared !== false;
  const calendarReady = readiness?.steps.some((step) => step.key === "calendar" && step.state === "done");
  const prompt = ready
    ? calendarReady && can("appointments.view")
      ? "What appointments do I have today?"
      : can("leads.view") || can("contacts.view")
        ? "Show me the new leads from this week."
        : can("activity.view") ? "What work was completed this week?" : null
    : null;

  const followUp = prompt ? {
    detail: "Start with a read-only question about your workspace. Review the question in the conversation before sending it.",
    href: "/growth-partner/conversation?q=" + encodeURIComponent(prompt),
    label: "Open with this question",
  } : ready ? {
    detail: "Open the shared conversation and ask a question about your business or saved work.",
    href: "/growth-partner/conversation",
    label: "Open AI Growth Partner",
  } : {
    detail: "Review your Business Brain and connection checks before starting new work.",
    href: "/growth-partner",
    label: "Review Partner setup",
  };

  const rows: Array<{ title: string; detail: string; href: string; label: string; question?: string | null }> = [
    ...(can("agents.configure") ? [{
      title: "Configure capability permissions",
      detail: "Review your Growth Partner’s actions and switch off any you want to restrict.",
      href: "/growth-partner#capability-access",
      label: "Configure permissions",
    }, {
      title: "Set conversation preferences",
      detail: "Choose your preferred tone, language and response length.",
      href: "/settings/ai",
      label: "Open Growth Partner Settings",
    }] : []),
    ...(can("integrations.view") ? [{
      title: "Connect optional tools",
      detail: "See which integrations are available and where to authorize or request a connection.",
      href: "/settings/integrations",
      label: "Open Integrations",
    }] : []),
    ...(can("agents.configure") ? [{
      title: "Plan recurring work",
      detail: scheduledWorkEnabled
        ? "Review scheduled work. New schedules are saved paused and must be enabled separately."
        : "Review scheduled work. Saved schedules wait while the scheduler is off.",
      href: "/work#scheduled-work",
      label: "Open scheduled work",
    }] : []),
    { title: "First Partner action", ...followUp, question: prompt },
  ];

  return (
    <section aria-labelledby="partner-next-steps" className="mx-auto mb-6 max-w-6xl rounded-2xl border border-line bg-surface p-5 sm:p-7">
      <h2 id="partner-next-steps" className="text-[17px] font-semibold tracking-tight text-ink">Next steps for your AI Growth Partner</h2>
      <ul className="mt-2 divide-y divide-line">
        {rows.map(({ title, detail, href, label, question }) => (
          <li key={title} className="flex flex-wrap items-start justify-between gap-x-5 gap-y-1 py-3">
            <div className="min-w-0 max-w-2xl flex-1 basis-60">
              <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{detail}</p>
              {question && <p className="mt-2 text-[14px] font-medium text-ink">{question}</p>}
            </div>
            <Link href={href} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-primary-ink hover:bg-primary-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
              {label}<ArrowRight className="size-3.5 shrink-0" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
