"use client";

import * as React from "react";
import Link from "next/link";
import { Activity, BarChart3, Bot, Building2, FileText, Inbox, LifeBuoy, PenLine, Plug, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { useOpsConsole } from "@/components/aqi/ops/ops-context";
import { quickActionsFor, type OpsQuickAction } from "@/lib/aqi/ops/quick-actions";
import { cn } from "@/lib/utils";
import type { OpsScope } from "@/lib/aqi/ops/types";

const ICON: Record<string, React.ReactNode> = {
  health: <Activity className="size-4" aria-hidden />, client: <Building2 className="size-4" aria-hidden />, hermes: <Bot className="size-4" aria-hidden />,
  support: <LifeBuoy className="size-4" aria-hidden />, usage: <BarChart3 className="size-4" aria-hidden />, integrations: <Plug className="size-4" aria-hidden />,
  security: <ShieldCheck className="size-4" aria-hidden />, briefing: <FileText className="size-4" aria-hidden />, issue: <PenLine className="size-4" aria-hidden />,
  queue: <Inbox className="size-4" aria-hidden />,
};

const KIND_HINT: Record<OpsQuickAction["kind"], string> = { ask: "Asks AQi", link: "Opens a page", scope: "Opens the context picker", draft: "Starts a draft" };

export function OpsQuickActions({ scope, className }: { scope: OpsScope; className?: string }) {
  const { ask, draft, pickScope } = useOpsConsole();
  const actions = quickActionsFor(scope);
  const item = "group flex min-h-11 w-full items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
  const body = (a: OpsQuickAction) => (
    <>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-ink">{ICON[a.key] ?? <Sparkles className="size-4" aria-hidden />}</span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold leading-snug text-ink">{a.label}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-muted">{a.description}</span>
        <span className="sr-only">{KIND_HINT[a.kind]}</span>
      </span>
    </>
  );
  return (
    <section aria-labelledby="ops-quick-heading" className={className}>
      <h2 id="ops-quick-heading" className="mb-3 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.02em] text-ink"><Zap className="size-4 text-primary" aria-hidden />{scope.type === "platform" ? "Quick actions" : "Quick actions for this context"}</h2>
      <ul className={cn("grid gap-2", "sm:grid-cols-2 xl:grid-cols-1")}>
        {actions.map((a) => (
          <li key={a.key}>
            {a.kind === "link" && a.href ? (
              <Link href={a.href} className={item}>{body(a)}</Link>
            ) : (
              <button
                type="button"
                className={item}
                onClick={() => {
                  if (a.kind === "ask" && a.ask) ask(a.ask);
                  else if (a.kind === "draft" && a.draft) draft(a.draft);
                  else if (a.kind === "scope") pickScope();
                }}
              >
                {body(a)}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
