"use client";

import * as React from "react";
import { CalendarDays, Check, Clock, Mail, MessageCircle, Phone, RotateCcw, ShieldCheck, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/brand";
import { AGENT_BY_KEY } from "@/lib/agents";
import { useShowroom } from "@/components/demo/showroom/context";
import { ContextCta } from "@/components/demo/showroom/cta";
import { Chip, SectionHead, SimTag } from "@/components/demo/showroom/ui";

// One inbox for every channel and a calendar of what is booked. The visitor can open a conversation, read the reply the Appointment Setter prepared, approve it, and offer new times to a
// customer who asked to move. All of it is a drawing on invented people: Approve changes this page and sends nothing.

type Channel = "sms" | "email" | "chat" | "phone";
const CHANNEL = { sms: { label: "Text message", Icon: MessageCircle }, email: { label: "Email", Icon: Mail }, chat: { label: "Website chat", Icon: Globe }, phone: { label: "Missed call", Icon: Phone } } as const;

interface Thread {
  id: string;
  who: string;
  channel: Channel;
  preview: string;
  when: string;
  said: string;
  draft: string;
}

export function InboxView() {
  const { scenario } = useShowroom();
  const threads = React.useMemo<Thread[]>(
    () => [
      { id: "t1", who: scenario.lead, channel: "chat", when: "9:04", preview: scenario.enquiry, said: `Hi, I have ${scenario.enquiry}. Can someone help me this week?`, draft: `Hi ${scenario.lead.split(" ")[0]}, thanks for getting in touch. We can help. We have time on Thursday morning or Friday afternoon for ${scenario.appointment}. Which suits you?` },
      { id: "t2", who: "Pat W.", channel: "sms", when: "8:41", preview: "Is the price for this fixed?", said: `Is the price for ${scenario.deal} fixed or does it change?`, draft: "Good question. This is one we like to talk through, because it depends on what you need. Could we set up a short call?" },
      { id: "t3", who: "Lee N.", channel: "email", when: "Yesterday", preview: "Can we move our visit later in the week?", said: `Could we move ${scenario.appointment} to later in the week? Something has come up.`, draft: "No problem at all. I can offer Friday morning or Monday afternoon. Let me know which you prefer and I will confirm it." },
      { id: "t4", who: "Unknown caller", channel: "phone", when: "Yesterday", preview: "Missed call at 5:52", said: "Missed call, no voicemail.", draft: "Hi, sorry we missed your call. How can we help? Reply here or tell us a good time to call back." },
    ],
    [scenario],
  );
  const [open, setOpen] = React.useState(threads[0].id);
  const [approved, setApproved] = React.useState<Record<string, boolean>>({});
  const t = threads.find((x) => x.id === open) ?? threads[0];
  const ok = approved[t.id];
  const Ch = CHANNEL[t.channel].Icon;

  return (
    <div className="space-y-8">
      <SectionHead as="h1" eyebrow="Inbox & appointments" title="Every conversation in one place." lead="Texts, emails, website chats and missed calls arrive in one inbox. The Appointment Setter prepares replies; you approve what goes out." />

      <div className="sx-panel overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">Unified inbox</h2>
          <SimTag>Sample conversations</SimTag>
        </header>
        <div className="grid @4xl:grid-cols-[320px_minmax(0,1fr)]">
          <ul aria-label="Conversations" className="max-h-[420px] divide-y divide-line overflow-y-auto border-b border-line @4xl:border-b-0 @4xl:border-r sx-scroll">
            {threads.map((th) => {
              const I = CHANNEL[th.channel].Icon;
              return (
                <li key={th.id}>
                  <button type="button" onClick={() => setOpen(th.id)} aria-current={th.id === open ? "true" : undefined} className={cn("flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors", th.id === open ? "bg-primary-soft" : "hover:bg-white/5")}>
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-primary-ink">
                      <I className="size-4" aria-hidden />
                      <span className="sr-only">{CHANNEL[th.channel].label}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[14px] font-semibold text-ink">{th.who}</span>
                        <span className="shrink-0 text-[12px] text-muted">{th.when}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[13px] text-muted">{th.preview}</span>
                      {approved[th.id] ? <Chip tone="ok" className="mt-1.5">Reply approved</Chip> : <Chip tone="violet" className="mt-1.5">Reply ready for you</Chip>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div key={t.id} className="sx-fade space-y-4 p-5">
            <div className="flex items-center gap-2 text-[13px] text-muted">
              <Ch className="size-4" aria-hidden />
              {CHANNEL[t.channel].label} · {t.who}
            </div>
            <p className="max-w-[85%] rounded-2xl rounded-bl-md border border-line bg-surface-2/70 px-4 py-3 text-[14px] leading-relaxed text-ink">{t.said}</p>
            <div className={cn("ml-auto max-w-[90%] rounded-2xl rounded-br-md border p-4", ok ? "border-success/40 bg-success-soft" : "border-violet/40 bg-violet-soft")}>
              <div className="mb-2 flex items-center gap-2">
                <AgentAvatar role={AGENT_BY_KEY.appointment_setter} size="xs" eager />
                <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">Prepared by the Appointment Setter</p>
              </div>
              <p className="text-[14px] leading-relaxed text-ink">{t.draft}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {ok ? (
                  <p role="status" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-success-ink">
                    <Check className="size-4" aria-hidden />
                    Approved in this demo. Nothing was sent.
                  </p>
                ) : (
                  <>
                    <button type="button" onClick={() => setApproved((a) => ({ ...a, [t.id]: true }))} className="sx-btn-primary inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-[13px] font-semibold">
                      <ShieldCheck className="size-4" aria-hidden />
                      Approve reply
                    </button>
                    <span className="text-[12px] text-muted">Waiting for your approval</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <AppointmentsPanel />

      <ContextCta
        plan="core"
        title="Get one inbox and calendar for my business"
        body="The unified inbox, booking and the Appointment Setter are part of your core implementation, connected to the channels and calendar you choose, where supported."
        consultLabel="Book a free consultation"
        secondary={{ view: "automation", label: "See Automation Studio" }}
      />
    </div>
  );
}

type Slot = { day: string; time: string; who: string; what: string; state: "confirmed" | "awaiting" | "reschedule" | "offered" };

function AppointmentsPanel() {
  const { scenario } = useShowroom();
  const initial = React.useMemo<Slot[]>(
    () => [
      { day: "Mon", time: "10:00", who: "Robin E.", what: scenario.appointment, state: "confirmed" },
      { day: "Tue", time: "14:30", who: scenario.lead, what: scenario.appointment, state: "awaiting" },
      { day: "Wed", time: "09:00", who: "Lee N.", what: scenario.appointment, state: "reschedule" },
      { day: "Thu", time: "11:00", who: "Cam D.", what: "Proposal review", state: "confirmed" },
      { day: "Fri", time: "15:00", who: "Ari F.", what: "Kick-off call", state: "confirmed" },
    ],
    [scenario],
  );
  const [slots, setSlots] = React.useState(initial);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const act = (i: number) => setSlots((s) => s.map((x, k) => (k === i ? { ...x, state: x.state === "awaiting" ? "confirmed" : "offered" } : x)));
  const chip = (s: Slot["state"]) => (s === "confirmed" ? <Chip tone="ok">Confirmed</Chip> : s === "awaiting" ? <Chip tone="warn">Awaiting confirmation</Chip> : s === "reschedule" ? <Chip tone="violet">Asked to move</Chip> : <Chip tone="info">New times drafted</Chip>);
  return (
    <section aria-labelledby="appts-heading" className="sx-panel overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 id="appts-heading" className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <CalendarDays className="size-4 text-primary-ink" aria-hidden />
          This week&rsquo;s appointments
        </h2>
        <div className="flex items-center gap-2">
          <SimTag>Sample calendar</SimTag>
          <button type="button" onClick={() => setSlots(initial)} className="sx-btn-quiet inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium">
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </button>
        </div>
      </header>
      <ul className="grid gap-px bg-line @2xl:grid-cols-5">
        {days.map((d) => {
          const i = slots.findIndex((s) => s.day === d);
          const s = slots[i];
          return (
            <li key={d} className="flex min-h-44 flex-col gap-2 bg-surface p-4">
              <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">{d}</p>
              <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                <Clock className="size-3.5 text-primary-ink" aria-hidden />
                {s.time}
              </p>
              <p className="text-[14px] font-semibold leading-snug text-ink">{s.who}</p>
              <p className="text-[12px] leading-snug text-muted">{s.what}</p>
              <div className="mt-auto space-y-2">
                {chip(s.state)}
                {(s.state === "awaiting" || s.state === "reschedule") && (
                  <button type="button" onClick={() => act(i)} className="sx-btn-quiet inline-flex min-h-9 w-full items-center justify-center rounded-lg px-2.5 py-1.5 text-center text-[12px] font-semibold">
                    {s.state === "awaiting" ? "Prepare confirmation" : "Offer new times"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line px-5 py-3 text-[13px] leading-relaxed text-muted">The Appointment Setter checks your connected calendar before it offers a time. Anything it prepares waits for your approval before a customer sees it.</p>
    </section>
  );
}
