"use client";

import * as React from "react";
import Link from "next/link";
import { useReducedMotion } from "motion/react";
import { HeartPulse, Newspaper, ShieldCheck, Sparkles } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { PageHero } from "@/components/ui/workspace";
import { OpsBriefings } from "@/components/aqi/ops/ops-briefings";
import { OpsChat } from "@/components/aqi/ops/ops-chat";
import { OpsConsoleContext, type OpsConsoleActions } from "@/components/aqi/ops/ops-context";
import { OpsQuickActions } from "@/components/aqi/ops/ops-quick-actions";
import { useOpsChat } from "@/components/aqi/ops/use-ops-chat";
import { PLATFORM_SCOPE, type OpsScope } from "@/lib/aqi/ops/types";

/**
 * The Super Admin operations workspace: the overview (rendered on the server and passed in as a slot),
 * context-aware quick actions, and the conversation workspace. Every control here either opens a real
 * page or sends a real question; nothing is decorative.
 */
export function OpsConsole({ overview }: { overview: React.ReactNode }) {
  const [scope, setScope] = React.useState<OpsScope>(PLATFORM_SCOPE);
  const chat = useOpsChat();
  const [pickerSignal, setPickerSignal] = React.useState(0);
  const [draft, setDraft] = React.useState<{ text: string; nonce: number } | null>(null);
  const [briefingsOpen, setBriefingsOpen] = React.useState(false);
  const workspaceRef = React.useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const { send, sending } = chat;

  const reveal = React.useCallback(() => {
    workspaceRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }, [reduced]);

  const actions = React.useMemo<OpsConsoleActions>(() => ({
    ask: (question) => { if (sending) { reveal(); return; } reveal(); void send(question, scope); },
    draft: (text) => { reveal(); setDraft({ text, nonce: Date.now() }); },
    pickScope: () => { reveal(); setPickerSignal((n) => n + 1); },
  }), [reveal, scope, send, sending]);

  return (
    <OpsConsoleContext.Provider value={actions}>
      <div className="module-stack space-y-6">
        <PageHero
          tone="dark"
          eyebrow="Super Admin"
          icon={<Sparkles />}
          title="AQi Operations"
          description="Your AI Platform Operations Copilot. It investigates from recorded evidence, shows its sources and what it could not measure, and prepares changes for your confirmation."
          action={
            <>
              <Button variant="brand" onClick={() => setBriefingsOpen(true)}><Newspaper className="size-4" aria-hidden />Briefings</Button>
              <ButtonLink href="/admin/health" variant="outline" className="!border-white/20 !text-white hover:!bg-white/10"><HeartPulse className="size-4" aria-hidden />System health</ButtonLink>
            </>
          }
        />

        {overview}

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section ref={workspaceRef} aria-label="Conversation workspace" className="flex h-[78dvh] min-h-[560px] max-h-[900px] min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-soft xl:order-1">
            <OpsChat chat={chat} scope={scope} onScopeChange={setScope} variant="page" pickerSignal={pickerSignal} draft={draft} />
          </section>
          <aside className="min-w-0 space-y-6 xl:order-2" aria-label="Shortcuts and safeguards">
            <OpsQuickActions scope={scope} />
            <section aria-labelledby="ops-safeguards" className="rounded-2xl border border-line bg-surface-2/50 p-4">
              <h2 id="ops-safeguards" className="flex items-center gap-2 text-[14px] font-semibold text-ink"><ShieldCheck className="size-4 text-primary" aria-hidden />How it stays safe</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-muted">
                <li>It reads operational metadata, never private client conversations or CRM records.</li>
                <li>Reading a client is an audited access, limited to the context you selected.</li>
                <li>It cannot change anything by itself. Changes are previews that you confirm; success is reported only after the system is read back.</li>
                <li>Every check and action is recorded in the <Link href="/admin/audit" className="font-medium text-primary-ink underline-offset-2 hover:underline">audit log</Link>.</li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
      <OpsBriefings open={briefingsOpen} onOpenChange={setBriefingsOpen} />
    </OpsConsoleContext.Provider>
  );
}
