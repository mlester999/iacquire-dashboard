"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowUpRight, CheckCircle2, HeadsetIcon, LifeBuoy, MessageCircleQuestion, Send, Ticket, X } from "lucide-react";
import { LogoMark, ThinkingDots } from "@/components/brand";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { createTicketAction, listMyTicketsAction } from "@/app/actions/support";
import { cn, relativeTime, sentenceCase } from "@/lib/utils";

interface HelpMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode?: "ai" | "help_search" | "redirect" | "escalation" | null;
  links?: Array<{ label: string; href: string }>;
}

const SUGGESTIONS = [
  "How do I set up my AI employees?",
  "What does 'Setup required' mean?",
  "How do approvals work?",
  "How do I invite my team?",
];

type View = "chat" | "human" | "requests";

function useIsDesktop() {
  const [desktop, setDesktop] = React.useState(true);
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    const set = () => setDesktop(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);
  return desktop;
}

export function HelpWidget({
  firstName,
  canOpenTickets,
  aiAvailable,
  raised,
}: {
  firstName: string | null;
  canOpenTickets: boolean;
  aiAvailable: boolean;
  /** Lift the launcher above a bottom composer (chat pages). */
  raised?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<View>("chat");
  const desktop = useIsDesktop();
  const reduce = useReducedMotion();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const launcherRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        launcherRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ view?: View }>).detail;
      setView(detail?.view ?? "chat");
      setOpen(true);
    };
    window.addEventListener("iaq:open-help", handler);
    return () => window.removeEventListener("iaq:open-help", handler);
  }, []);

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            ref={launcherRef}
            type="button"
            onClick={() => setOpen(true)}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            whileHover={reduce ? undefined : { scale: 1.06, y: -2 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 22 }}
            className="fixed z-40 flex size-14 items-center justify-center rounded-2xl brand-gradient text-white shadow-[0_14px_40px_-10px_rgba(44,91,255,0.65)] ring-1 ring-white/20"
            style={{
              right: "max(16px, env(safe-area-inset-right))",
              bottom: raised && !desktop ? "calc(max(12px, env(safe-area-inset-bottom)) + 150px)" : "max(16px, env(safe-area-inset-bottom))",
            }}
            aria-label="Open iAcquire help"
            data-tour="help"
          >
            <span className="absolute inset-0 rounded-2xl bg-white/0 transition hover:bg-white/10" />
            <MessageCircleQuestion className="size-6" />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <>
            {!desktop && (
              <motion.div
                className="fixed inset-0 z-40 bg-black/30"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setOpen(false)}
                aria-hidden
              />
            )}
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal={!desktop}
              aria-label="iAcquire help"
              initial={desktop ? { opacity: 0, y: 24, scale: 0.96 } : { y: "100%" }}
              animate={desktop ? { opacity: 1, y: 0, scale: 1 } : { y: 0 }}
              exit={desktop ? { opacity: 0, y: 16, scale: 0.97 } : { y: "100%" }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
              style={desktop ? { transformOrigin: "bottom right" } : undefined}
              className={cn(
                "fixed z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-float",
                desktop
                  ? "bottom-6 right-6 h-[min(640px,calc(100dvh-48px))] w-[400px] rounded-3xl"
                  : "inset-x-0 bottom-0 h-[92dvh] rounded-t-3xl",
              )}
            >
              <HelpHeader view={view} setView={setView} onClose={() => setOpen(false)} canOpenTickets={canOpenTickets} />
              <div className="relative min-h-0 flex-1">
                {view === "chat" && <AssistantView firstName={firstName} aiAvailable={aiAvailable} onHuman={() => setView("human")} canOpenTickets={canOpenTickets} />}
                {view === "human" && <HumanView onDone={() => setView("requests")} />}
                {view === "requests" && <RequestsView onNew={() => setView("human")} onNavigate={() => setOpen(false)} />}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function HelpHeader({ view, setView, onClose, canOpenTickets }: { view: View; setView: (v: View) => void; onClose: () => void; canOpenTickets: boolean }) {
  return (
    <div className="relative shrink-0 overflow-hidden border-b border-line">
      <div aria-hidden className="absolute inset-0 opacity-90" style={{ background: "radial-gradient(400px 160px at 0% 0%, rgba(44,91,255,0.16), transparent 70%), radial-gradient(300px 140px at 100% 0%, rgba(139,92,255,0.14), transparent 70%)" }} />
      <div className="relative flex items-center gap-3 px-4 pb-3 pt-4">
        {view !== "chat" ? (
          <button type="button" onClick={() => setView("chat")} className="flex size-9 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2" aria-label="Back to assistant">
            <ArrowLeft className="size-4" />
          </button>
        ) : (
          <LogoMark className="size-9" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold tracking-tight text-ink">{view === "chat" ? "iAcquire Assistant" : view === "human" ? "Talk to iAcquire Team" : "Your support requests"}</p>
          <p className="text-[12px] text-muted">{view === "chat" ? "Help with your workspace and AI team" : view === "human" ? "A real person on our team will reply" : "Follow up on earlier requests"}</p>
        </div>
        <button type="button" onClick={onClose} className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close help">
          <X className="size-4" />
        </button>
      </div>
      {view === "chat" && canOpenTickets && (
        <div className="relative flex gap-2 px-4 pb-3">
          <button type="button" onClick={() => setView("human")} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink-2 shadow-soft hover:text-ink">
            <HeadsetIcon className="size-3.5 text-primary" /> Talk to iAcquire Team
          </button>
          <button type="button" onClick={() => setView("requests")} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] font-medium text-ink-2 shadow-soft hover:text-ink">
            <Ticket className="size-3.5 text-violet" /> My requests
          </button>
        </div>
      )}
    </div>
  );
}

function AssistantView({ firstName, aiAvailable, onHuman, canOpenTickets }: { firstName: string | null; aiAvailable: boolean; onHuman: () => void; canOpenTickets: boolean }) {
  const [messages, setMessages] = React.useState<HelpMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const loaded = React.useRef(false);

  React.useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    fetch("/api/help")
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((d: { messages: HelpMessage[] }) => setMessages(d.messages ?? []))
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || pending) return;
    setError(null);
    setInput("");
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: "user", content: question }]);
    setPending(true);
    try {
      const res = await fetch("/api/help", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: data.content, mode: data.mode, links: data.links }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl rounded-tl-md border border-line bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink">
          Hi{firstName ? ` ${firstName}` : ""}! I&apos;m the iAcquire Assistant. I can help with your workspace, AI employees, approvals, and settings.
          {!aiAvailable && <span className="mt-1 block text-[12.5px] text-muted">Answers come from the iAcquire help center.</span>}
        </motion.div>
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="px-1 text-[12px] font-medium text-muted">Suggested questions</p>
            {SUGGESTIONS.map((s, i) => (
              <motion.button
                key={s}
                type="button"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 * i }}
                onClick={() => ask(s)}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left text-[13.5px] text-ink-2 shadow-soft transition hover:border-primary/30 hover:text-ink"
              >
                {s}
                <ArrowUpRight className="size-3.5 shrink-0 text-faint" />
              </motion.button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <motion.div key={m.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            {m.role === "user" ? (
              <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-primary px-3.5 py-2.5 text-[14px] leading-relaxed text-white">{m.content}</div>
            ) : (
              <div className="max-w-[92%] space-y-2">
                <div className="rounded-2xl rounded-tl-md border border-line bg-surface-2 px-4 py-3 text-ink">
                  <Markdown className="text-[14px]">{m.content}</Markdown>
                </div>
                {m.links && m.links.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {m.links.map((l) => (
                      <Link key={l.href} href={l.href} className="inline-flex h-7 items-center gap-1 rounded-lg bg-primary-soft px-2.5 text-[12px] font-medium text-primary-ink hover:bg-primary/15">
                        {l.label} <ArrowUpRight className="size-3" />
                      </Link>
                    ))}
                  </div>
                )}
                {m.mode === "escalation" && canOpenTickets && (
                  <Button size="sm" variant="brand" onClick={onHuman}>
                    <HeadsetIcon className="size-3.5" /> Talk to iAcquire Team
                  </Button>
                )}
              </div>
            )}
          </motion.div>
        ))}
        {pending && (
          <div className="flex items-center gap-2 text-muted" role="status">
            <div className="rounded-2xl rounded-tl-md border border-line bg-surface-2 px-4 py-3">
              <ThinkingDots />
            </div>
            <span className="sr-only">Assistant is answering</span>
          </div>
        )}
        {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p>}
      </div>
      <form
        className="shrink-0 border-t border-line p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-surface p-1.5 focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10">
          <label htmlFor="help-input" className="sr-only">
            Ask the iAcquire Assistant
          </label>
          <input
            id="help-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={1000}
            placeholder="Ask about your workspace…"
            className="h-9 min-w-0 flex-1 bg-transparent px-2 text-[14px] outline-none placeholder:text-faint"
            autoComplete="off"
          />
          <Button type="submit" size="icon-sm" variant="brand" disabled={!input.trim() || pending} aria-label="Send question">
            <Send className="size-3.5" />
          </Button>
        </div>
      </form>
    </div>
  );
}

function HumanView({ onDone }: { onDone: () => void }) {
  const pathname = usePathname();
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [category, setCategory] = React.useState("general");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<{ ref: string; externalNotification: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const res = await createTicketAction({ subject, message, category: category as never, pageContext: pathname });
    setPending(false);
    if (!res.ok) return setError(res.error);
    setCreated(res.data);
  };

  if (created) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 18 }} className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-success-soft text-success-ink">
          <CheckCircle2 className="size-7" />
        </motion.div>
        <p className="text-[16px] font-semibold text-ink">Request {created.ref} created</p>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          Status: <span className="font-medium text-ink">Open</span>. Our team sees it in the iAcquire support inbox and will reply here and on your Support page.
          {created.externalNotification === "sent" ? " We've also alerted the team directly." : ""}
        </p>
        <div className="mt-6 flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            View my requests
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="scrollbar-thin flex h-full flex-col gap-4 overflow-y-auto px-4 py-4">
      <p className="text-[13.5px] leading-relaxed text-muted">Tell us what you need help with. We&apos;ll attach your workspace and this page so you don&apos;t have to explain the context.</p>
      <Field label="What do you need help with?" htmlFor="ticket-subject">
        <Input id="ticket-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} required placeholder="e.g. Connect our calendar" />
      </Field>
      <Field label="Topic" htmlFor="ticket-category">
        <Select id="ticket-category" value={category} onChange={(e) => setCategory(e.target.value)}>
          {["general", "ai_employees", "integrations", "onboarding", "account", "billing", "bug"].map((c) => (
            <option key={c} value={c}>
              {sentenceCase(c === "ai_employees" ? "AI employees" : c)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Details" htmlFor="ticket-message">
        <Textarea id="ticket-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} required rows={5} placeholder="A short description is perfect." />
      </Field>
      {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p>}
      <div className="safe-bottom mt-auto">
        <Button type="submit" variant="brand" className="w-full" loading={pending} disabled={subject.trim().length < 3 || message.trim().length < 5}>
          <LifeBuoy className="size-4" /> Send to iAcquire Team
        </Button>
      </div>
    </form>
  );
}

const STATUS_TONE: Record<string, string> = {
  open: "bg-primary-soft text-primary-ink",
  in_progress: "bg-violet-soft text-violet-ink",
  waiting_for_client: "bg-warning-soft text-warning-ink",
  resolved: "bg-success-soft text-success-ink",
  closed: "bg-surface-2 text-muted",
};

function RequestsView({ onNew, onNavigate }: { onNew: () => void; onNavigate: () => void }) {
  const [rows, setRows] = React.useState<Array<{ id: string; ref: string; subject: string; status: string; lastMessageAt: string }> | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    listMyTicketsAction().then((r) => (r.ok ? setRows(r.data) : setError(r.error)));
  }, []);
  return (
    <div className="scrollbar-thin h-full overflow-y-auto px-4 py-4">
      {error && <p className="text-[13px] text-danger-ink">{error}</p>}
      {rows === null && !error && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      )}
      {rows?.length === 0 && <p className="py-10 text-center text-[13.5px] text-muted">No support requests yet.</p>}
      <div className="space-y-2">
        {rows?.map((t) => (
          <Link key={t.id} href={`/support/${t.id}`} onClick={onNavigate} className="block rounded-xl border border-line bg-surface px-3.5 py-3 shadow-soft transition hover:border-line-strong">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11.5px] text-muted">{t.ref}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[t.status])}>{sentenceCase(t.status)}</span>
            </div>
            <p className="mt-1 truncate text-[13.5px] font-medium text-ink">{t.subject}</p>
            <p className="mt-0.5 text-[11.5px] text-faint">Updated {relativeTime(t.lastMessageAt)}</p>
          </Link>
        ))}
      </div>
      <Button variant="secondary" className="mt-4 w-full" onClick={onNew}>
        New request
      </Button>
    </div>
  );
}

export function openHelp(view: View = "chat") {
  window.dispatchEvent(new CustomEvent("iaq:open-help", { detail: { view } }));
}
