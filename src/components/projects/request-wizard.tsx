"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, FileText, Info, Lightbulb, Paperclip, Plus, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { Card, Field, Input, ProgressBar, Select, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { bytesLabel } from "@/components/projects/common";
import { createProjectRequestAction } from "@/app/actions/projects";
import { newIdempotencyKey } from "@/lib/support/content";
import { BUDGET_BANDS, formatDelivery, formatPrice, suggestServices, type ServiceView } from "@/lib/projects";
import { cn, sentenceCase } from "@/lib/utils";

const STEPS = ["The idea", "How it works today", "Your tools", "Optional details", "Review"] as const;
const COMMON_TOOLS = ["GoHighLevel", "n8n", "Make.com", "Zapier", "Google Sheets", "Airtable", "Notion", "Slack", "ClickUp", "Shopify", "Stripe", "HubSpot", "Google Calendar", "Gmail", "QuickBooks", "WordPress"];
const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ".pdf,.docx,.png,.jpg,.jpeg,.txt,.md,.csv";
const todayIso = () => new Date().toISOString().slice(0, 10);

export function RequestWizard({
  services,
  connected,
  initialServiceSlug,
  reference,
}: {
  services: ServiceView[];
  connected: string[];
  initialServiceSlug: string | null;
  reference: { slug: string; title: string } | null;
}) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const preselected = services.find((s) => s.slug === initialServiceSlug) ?? null;
  const [step, setStep] = React.useState(0);
  const [title, setTitle] = React.useState(preselected?.name ?? (reference ? `Something similar to ${reference.title.split(":")[0]}` : ""));
  const [problem, setProblem] = React.useState("");
  const [currentProcess, setCurrentProcess] = React.useState("");
  const [desiredOutcome, setDesiredOutcome] = React.useState("");
  const [tools, setTools] = React.useState<string[]>([]);
  const [toolInput, setToolInput] = React.useState("");
  const [deadline, setDeadline] = React.useState("");
  const [budget, setBudget] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [serviceSlug, setServiceSlug] = React.useState<string | null>(preselected?.slug ?? null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  // One key per form: sending it twice (a double click, a dropped connection) makes one request.
  const retryKey = React.useRef(newIdempotencyKey());

  const selected = services.find((s) => s.slug === serviceSlug) ?? null;
  const suggestions = React.useMemo(
    () => suggestServices(`${title} ${problem} ${currentProcess} ${desiredOutcome}`, tools, services, connected).filter((s) => s.service.slug !== serviceSlug),
    [title, problem, currentProcess, desiredOutcome, tools, services, connected, serviceSlug],
  );

  const valid = [
    title.trim().length >= 3 && problem.trim().length >= 10,
    currentProcess.trim().length >= 10 && desiredOutcome.trim().length >= 10,
    true,
    !deadline || deadline >= todayIso(),
    true,
  ];

  function addTool(name: string) {
    const t = name.trim();
    if (!t || tools.some((x) => x.toLowerCase() === t.toLowerCase()) || tools.length >= 30) return;
    setTools([...tools, t.slice(0, 60)]);
    setToolInput("");
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.size > MAX_BYTES) toast.error(`${f.name} is over 10 MB.`);
      else if (next.length >= MAX_FILES) toast.error(`You can attach up to ${MAX_FILES} files here. More can be added after you submit.`);
      else next.push(f);
    }
    setFiles(next);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function submit() {
    setPending(true);
    setError(null);
    const res = await createProjectRequestAction({
      title,
      problem,
      currentProcess,
      desiredOutcome,
      tools,
      preferredDeadline: deadline || null,
      budgetRange: (budget || null) as (typeof BUDGET_BANDS)[number] | null,
      serviceSlug,
      idempotencyKey: retryKey.current,
    });
    if (!res.ok) {
      setPending(false);
      setError(res.error);
      return;
    }
    const failed: string[] = [];
    for (const f of files) {
      const body = new FormData();
      body.set("file", f);
      try {
        const r = await fetch(`/api/projects/${res.data.id}/files`, { method: "POST", body });
        if (!r.ok) failed.push(f.name);
      } catch {
        failed.push(f.name);
      }
    }
    if (failed.length) toast.warning(`Your request was sent, but ${failed.join(", ")} didn't upload. You can add it on the project page.`);
    toast.success(`Request ${res.data.ref} sent`);
    router.push(`/projects/${res.data.id}?submitted=1`);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary-soft/70 via-surface to-surface p-5 sm:p-6">
        <Link href="/add-ons" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" /> Custom Projects &amp; Add-ons
        </Link>
        <p className="mt-4 text-[10px] font-semibold uppercase tracking-[.16em] text-primary">From your idea to a clear scope</p>
        <h1 className="mt-2 text-balance text-[26px] font-semibold leading-tight tracking-[-0.035em] sm:text-[30px]">What would make your business work better?</h1>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">Describe it in your own words. You don&apos;t need to know the technical platforms. We&apos;ll review it, ask anything we&apos;re missing, and send a written quote. Nothing is charged.</p>
      </div>

      <div>
        <ProgressBar value={((step + 1) / STEPS.length) * 100} label={`Step ${step + 1} of ${STEPS.length}`} />
        <ol className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li key={label} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[11px] font-medium", i === step ? "border-primary/25 bg-primary-soft text-primary-ink" : i < step ? "border-success/20 bg-success-soft/40 text-success-ink" : "border-line bg-surface-2/50 text-muted")}>
              <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-[9px]",i===step?"bg-primary text-white":i<step?"bg-success text-white":"bg-surface-3")}>{i<step?<Check className="size-3"/>:i+1}</span>{label}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="p-5 sm:p-6">
          <p className="mb-4 border-b border-line pb-3 text-[11px] font-semibold uppercase tracking-[.1em] text-primary">{STEPS[step]} · Step {step+1} of {STEPS.length}</p>
          {/* Enter-only animation: an exit step would block the next one whenever animations are throttled. */}
          <motion.div key={step} initial={false} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.18 }} className="space-y-5">
              {step === 0 && (
                <>
                  {reference && (
                    <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-[13px] text-muted">
                      <Info className="mt-0.5 size-4 shrink-0" /> You&apos;re asking for something similar to{" "}
                      <Link href={`/our-work/${reference.slug}`} className="font-medium text-primary hover:underline">
                        {reference.title}
                      </Link>
                      . Tell us what&apos;s different for your business.
                    </p>
                  )}
                  {selected && (
                    <div className="flex items-start justify-between gap-3 rounded-xl border border-primary/25 bg-primary-soft/50 p-3.5">
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium text-primary-ink">Requesting the service</p>
                        <p className="text-[14px] font-semibold">{selected.name}</p>
                        <p className="text-[12px] text-muted">
                          {formatPrice(selected.price)}
                          {selected.deliveryMinDays ? ` · typically ${formatDelivery(selected.deliveryMinDays, selected.deliveryMaxDays)}` : ""} · confirmed in writing after review
                        </p>
                      </div>
                      <Button size="icon-sm" variant="ghost" aria-label="Remove selected service" onClick={() => setServiceSlug(null)}>
                        <X className="size-4" />
                      </Button>
                    </div>
                  )}
                  <Field label="What would you like us to build?" htmlFor="rq-title" hint="A short name is fine. For example: an AI that answers our phone calls.">
                    <Input id="rq-title" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} autoFocus />
                  </Field>
                  <Field label="What business problem are you trying to solve?" htmlFor="rq-problem" hint="What's going wrong or taking too much time today?">
                    <Textarea id="rq-problem" rows={5} value={problem} maxLength={2000} onChange={(e) => setProblem(e.target.value)} />
                  </Field>
                </>
              )}
              {step === 1 && (
                <>
                  <Field label="How does your current process work?" htmlFor="rq-process" hint="Walk us through it step by step, including who does what and which tools are involved.">
                    <Textarea id="rq-process" rows={5} value={currentProcess} maxLength={2000} onChange={(e) => setCurrentProcess(e.target.value)} autoFocus />
                  </Field>
                  <Field label="What would you like the new system to do?" htmlFor="rq-outcome" hint="Describe the ideal result. What happens, automatically, once it exists?">
                    <Textarea id="rq-outcome" rows={5} value={desiredOutcome} maxLength={2000} onChange={(e) => setDesiredOutcome(e.target.value)} />
                  </Field>
                </>
              )}
              {step === 2 && (
                <>
                  <Field label="Which tools do you currently use?" htmlFor="rq-tool" hint="CRM, calendar, email, spreadsheets, store, phone system… Add anything that comes to mind. Not sure? Skip this.">
                    <div className="flex gap-2">
                      <Input
                        id="rq-tool"
                        value={toolInput}
                        placeholder="e.g. HubSpot"
                        onChange={(e) => setToolInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addTool(toolInput);
                          }
                        }}
                      />
                      <Button variant="secondary" onClick={() => addTool(toolInput)} disabled={!toolInput.trim()}>
                        <Plus className="size-4" /> Add
                      </Button>
                    </div>
                  </Field>
                  {tools.length > 0 && (
                    <ul className="flex flex-wrap gap-2" aria-label="Your tools">
                      {tools.map((t) => (
                        <li key={t}>
                          <button type="button" onClick={() => setTools(tools.filter((x) => x !== t))} className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1 text-[12.5px] font-medium text-primary-ink hover:bg-primary/15" aria-label={`Remove ${t}`}>
                            {t} <X className="size-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div>
                    <p className="mb-2 text-[12px] font-medium text-muted">Common tools</p>
                    <div className="flex flex-wrap gap-1.5">
                      {COMMON_TOOLS.filter((t) => !tools.some((x) => x.toLowerCase() === t.toLowerCase())).map((t) => (
                        <button key={t} type="button" onClick={() => addTool(t)} className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-ink-2 transition hover:border-primary hover:text-primary">
                          + {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {step === 3 && (
                <>
                  <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-[13px] text-muted">
                    <Info className="mt-0.5 size-4 shrink-0" /> Everything on this page is optional. Share only what helps us scope it well.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Preferred deadline" htmlFor="rq-deadline" optional hint="A target date, if there's a real one.">
                      <Input id="rq-deadline" type="date" min={todayIso()} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                    </Field>
                    <Field label="Budget range" htmlFor="rq-budget" optional hint="Helps us propose something that fits. It isn't a quote.">
                      <Select id="rq-budget" value={budget} onChange={(e) => setBudget(e.target.value)}>
                        <option value="">Prefer not to say</option>
                        {BUDGET_BANDS.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Documents, screenshots or examples" htmlFor="rq-files" optional hint={`Up to ${MAX_FILES} files, 10 MB each (PDF, Word, images, text or CSV). Stored privately; only you and the iAcquire team can see them.`}>
                    <div className="space-y-2">
                      <label htmlFor="rq-files" className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface-2/50 px-4 py-6 text-[13px] text-muted transition hover:border-primary hover:text-primary">
                        <Paperclip className="size-4" /> Choose files to attach
                        <input ref={fileRef} id="rq-files" type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => addFiles(e.target.files)} />
                      </label>
                      {files.map((f, i) => (
                        <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px]">
                          <FileText className="size-4 shrink-0 text-muted" />
                          <span className="min-w-0 flex-1 truncate">{f.name}</span>
                          <span className="shrink-0 text-[11.5px] text-faint">{bytesLabel(f.size)}</span>
                          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="rounded-md p-1 text-muted hover:text-ink">
                            <X className="size-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </Field>
                </>
              )}
              {step === 4 && (
                <div className="space-y-4">
                  <h3 className="text-[16px] font-semibold">Review your request</h3>
                  <dl className="divide-y divide-line overflow-hidden rounded-xl bg-surface-2/50 text-[13.5px] ring-1 ring-inset ring-line">
                    {[
                      ["What to build", title],
                      ["The problem", problem],
                      ["Today's process", currentProcess],
                      ["Desired result", desiredOutcome],
                      ["Tools", tools.join(", ") || "Not specified"],
                      ["Deadline", deadline || "No preference"],
                      ["Budget range", budget || "Prefer not to say"],
                      ["Attachments", files.length ? files.map((f) => f.name).join(", ") : "None"],
                      ["Service", selected ? selected.name : "Custom project"],
                    ].map(([k, v]) => (
                      <div key={k} className="grid gap-1 px-4 py-3 sm:grid-cols-[150px_1fr]">
                        <dt className="text-[12px] font-medium uppercase tracking-[.06em] text-muted">{k}</dt>
                        <dd className="whitespace-pre-wrap break-words text-ink">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="flex items-start gap-2 rounded-xl border border-success/25 bg-success-soft/60 p-3.5 text-[13px] leading-relaxed text-success-ink">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0" /> Submitting only sends your request to the iAcquire team. You won&apos;t be charged, and nothing is built until you&apos;ve reviewed and accepted a written quote.
                  </p>
                  {error && (
                    <p role="alert" className="rounded-xl bg-danger-soft p-3 text-[13px] text-danger-ink">
                      {error}
                    </p>
                  )}
                </div>
              )}
          </motion.div>

          <div className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-4">
            <Button variant="secondary" onClick={() => setStep(step - 1)} disabled={step === 0 || pending}>
              <ArrowLeft className="size-4" /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="brand" onClick={() => setStep(step + 1)} disabled={!valid[step]}>
                {step === 2 || step === 3 ? "Continue" : "Next"} <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button variant="brand" loading={pending} disabled={!valid.every(Boolean)} onClick={() => void submit()}>
                <Send className="size-4" /> Send request
              </Button>
            )}
          </div>
        </Card>

        <aside aria-label="Suggestions" className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card className="p-4">
            <h3 className="flex items-center gap-2 text-[13.5px] font-semibold">
              <Lightbulb className="size-4 text-warning" /> Suggestions
            </h3>
            {suggestions.length === 0 ? (
              <p className="mt-2 text-[12.5px] leading-relaxed text-muted">As you describe your idea, we&apos;ll point out published services that look related, with their published price ranges.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                <AnimatePresence initial={false}>
                  {suggestions.map(({ service: s, reasons }) => (
                    <motion.li key={s.id} layout={!reduce} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0 }} className="rounded-xl border border-line bg-surface-2/60 p-3">
                      <p className="flex items-center gap-1.5 text-[13.5px] font-semibold">
                        <Sparkles className="size-3.5 text-primary" /> {s.name}
                      </p>
                      <p className="mt-0.5 text-[12.5px] tabular-nums text-ink-2">
                        {formatPrice(s.price)}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5"><InfoChip>Published, not a quote</InfoChip>{reasons.map((r) => <InfoChip key={r}>{r}</InfoChip>)}</div>
                      {s.coreOverlapNote && <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{s.coreOverlapNote}</p>}
                      <Button size="sm" variant="soft" className="mt-2" onClick={() => setServiceSlug(s.slug)}>
                        Use this service
                      </Button>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
            {suggestions.length > 0 && <p className="mt-3 text-[11.5px] leading-relaxed text-faint">Whether your project fits a published price is decided after our team reviews it.</p>}
          </Card>
          {connected.length > 0 && (
            <Card className="p-4">
              <p className="text-[12.5px] font-semibold">Already connected to your workspace</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {connected.map((c) => (
                  <StatusPill key={c} size="sm" tone="success">{c === "ghl" ? "GoHighLevel" : c === "hermes" ? "AI workforce" : c === "ghl_calendar" ? "GoHighLevel calendar" : sentenceCase(c)}</StatusPill>
                ))}
              </div>
            </Card>
          )}
          <Card className="p-4">
            <StatusPill tone="primary" icon={<Info className="size-3" />}>Good to know</StatusPill>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">Requests for the standard iAcquire AI employees in your package aren&apos;t add-ons. Check the AI Employees page first, and ask Support if you&apos;re unsure.</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
