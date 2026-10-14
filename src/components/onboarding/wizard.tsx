"use client";

import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  CalendarCheck2,
  Check,
  CheckCircle2,
  Cloud,
  Database,
  Heart,
  Loader2,
  Plus,
  Radar,
  Repeat,
  Send,
  Sparkles,
  Zap,
} from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { completeOnboardingAction, saveOnboardingAction } from "@/app/actions/onboarding";
import {
  BUSINESS_GOALS,
  LANGUAGES,
  LENGTH_COPY,
  TONE_COPY,
  TONES,
  websiteLooksValid,
  type OnboardingData,
  type ReplyLength,
} from "@/lib/agent-settings";
import { AGENT_BY_KEY, AGENT_ROLES, type AgentRoleKey } from "@/lib/agents";
import { cn } from "@/lib/utils";

const STEPS = ["Your business", "Your goals", "Communication", "Your AI team", "Generate"];
const GOAL_ICONS: Record<string, React.ReactNode> = {
  radar: <Radar className="size-5" />,
  calendar: <CalendarCheck2 className="size-5" />,
  zap: <Zap className="size-5" />,
  send: <Send className="size-5" />,
  database: <Database className="size-5" />,
  heart: <Heart className="size-5" />,
  repeat: <Repeat className="size-5" />,
  sparkles: <Sparkles className="size-5" />,
  plus: <Plus className="size-5" />,
};
const INDUSTRIES = ["Home services", "Real estate", "Dental", "Medical & wellness", "Legal", "Financial services", "Marketing agency", "Software & SaaS", "Construction", "Automotive", "Education", "Hospitality", "Retail & e-commerce", "Professional services", "Other"];
const NEVER_PROMISE_CHIPS = ["Exact prices before an assessment", "Same-day service", "Guaranteed results", "Discounts or refunds"];
const ESCALATE_CHIPS = ["a customer is upset", "a question is about pricing or contracts", "someone asks for a manager", "there's a safety issue"];

type GeneratedEmployee = { role: AgentRoleKey; name: string; summary: string; configStatus: string; agentStatus: string };

export function OnboardingWizard({
  initialData,
  initialStep,
  enabledRoles,
  completedAt,
}: {
  initialData: OnboardingData;
  initialStep: number;
  enabledRoles: AgentRoleKey[];
  completedAt: string | null;
}) {
  const reduce = useReducedMotion();
  const [data, setData] = React.useState<OnboardingData>(initialData);
  const [step, setStep] = React.useState(Math.min(Math.max(initialStep, 1), 5));
  const [dir, setDir] = React.useState(1);
  const [saveState, setSaveState] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [generating, setGenerating] = React.useState(false);
  const [result, setResult] = React.useState<GeneratedEmployee[] | null>(null);
  // What the server already has. Autosave only runs when the answers or step actually differ, so
  // opening the wizard (or React re-running effects in development) never writes anything.
  const lastSaved = React.useRef(JSON.stringify([Math.min(Math.max(initialStep, 1), 5), initialData]));

  // Debounced autosave whenever answers or the step change.
  React.useEffect(() => {
    const payload = JSON.stringify([step, data]);
    if (payload === lastSaved.current) return;
    const t = setTimeout(async () => {
      setSaveState("saving");
      const res = await saveOnboardingAction(step, data);
      if (res.ok) lastSaved.current = payload;
      setSaveState(res.ok ? "saved" : "error");
      if (!res.ok) toast.error(res.error);
    }, 700);
    return () => clearTimeout(t);
  }, [data, step]);

  const setBusiness = (k: keyof OnboardingData["business"], v: string) => setData((d) => ({ ...d, business: { ...d.business, [k]: v } }));
  const setComm = <K extends keyof OnboardingData["communication"]>(k: K, v: OnboardingData["communication"][K]) => setData((d) => ({ ...d, communication: { ...d.communication, [k]: v } }));

  const validate = (s: number) => {
    const e: Record<string, string> = {};
    if (s === 1) {
      if (data.business.companyName.trim().length < 2) e.companyName = "Add your company name.";
      if (data.business.description.trim().length < 10) e.description = "A sentence or two is perfect.";
      if (!websiteLooksValid(data.business.website.trim())) e.website = "That website address doesn't look right.";
    }
    if (s === 2 && !data.goals.selected.length) e.goals = "Choose at least one goal.";
    if (s === 4 && !data.workforce.selected.length) e.workforce = "Choose at least one AI employee.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const go = (next: number) => {
    if (next > step && !validate(step)) return;
    setDir(next > step ? 1 : -1);
    setStep(next);
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  const generate = async () => {
    for (const s of [1, 2, 4]) {
      if (!validate(s)) {
        setStep(s);
        return;
      }
    }
    setGenerating(true);
    await saveOnboardingAction(5, data);
    const res = await completeOnboardingAction();
    setGenerating(false);
    if (!res.ok) return toast.error(res.error);
    setResult(res.data.employees as GeneratedEmployee[]);
  };

  if (result) return <GeneratedSummary employees={result} />;

  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-4 sm:px-6">
      {/* Progress */}
      <div className="mb-8">
        <div className="mb-3 flex items-center justify-between text-[12.5px]">
          <span className="font-medium text-ink-2">
            Step {step} of {STEPS.length} · {STEPS[step - 1]}
          </span>
          <span className="flex items-center gap-1.5 text-muted" aria-live="polite">
            {saveState === "saving" ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Saving…
              </>
            ) : saveState === "saved" ? (
              <>
                <Cloud className="size-3.5" /> Saved
              </>
            ) : saveState === "error" ? (
              <span className="text-danger-ink">Not saved</span>
            ) : completedAt ? (
              "Previously completed"
            ) : null}
          </span>
        </div>
        <ol className="flex gap-1.5" aria-label="Progress">
          {STEPS.map((label, i) => (
            <li key={label} className="flex-1">
              <button
                type="button"
                onClick={() => i + 1 < step && go(i + 1)}
                disabled={i + 1 >= step}
                aria-label={`${label}${i + 1 < step ? " (completed)" : i + 1 === step ? " (current)" : ""}`}
                className="group block w-full"
              >
                <span className="block h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <motion.span className="block h-full rounded-full brand-gradient" initial={false} animate={{ width: i + 1 < step ? "100%" : i + 1 === step ? "50%" : "0%" }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} />
                </span>
                <span className={cn("mt-1.5 hidden text-[11.5px] sm:block", i + 1 === step ? "font-medium text-ink" : "text-faint")}>{label}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      <AnimatePresence mode="wait" custom={dir}>
        <motion.section
          key={step}
          custom={dir}
          initial={reduce ? false : { opacity: 0, x: dir * 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? undefined : { opacity: 0, x: dir * -24 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          aria-labelledby="step-title"
        >
          {step === 1 && (
            <StepShell title="Tell us about your business" subtitle="This helps every AI employee understand who you are. Only the first two are required.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Company name" htmlFor="ob-name" error={errors.companyName}>
                  <Input id="ob-name" value={data.business.companyName} maxLength={120} onChange={(e) => setBusiness("companyName", e.target.value)} aria-invalid={Boolean(errors.companyName) || undefined} />
                </Field>
                <Field label="Industry" htmlFor="ob-industry" optional>
                  <Select id="ob-industry" value={INDUSTRIES.includes(data.business.industry) ? data.business.industry : data.business.industry ? "Other" : ""} onChange={(e) => setBusiness("industry", e.target.value)}>
                    <option value="">Choose an industry</option>
                    {INDUSTRIES.map((i) => (
                      <option key={i}>{i}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="What does your business do?" htmlFor="ob-desc" error={errors.description} hint="One or two sentences, in your own words.">
                <Textarea id="ob-desc" rows={3} maxLength={2000} value={data.business.description} onChange={(e) => setBusiness("description", e.target.value)} placeholder="e.g. We're a family-owned roofing company helping homeowners in Austin with repairs and inspections." aria-invalid={Boolean(errors.description) || undefined} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Website" htmlFor="ob-web" optional error={errors.website}>
                  <Input id="ob-web" value={data.business.website} maxLength={300} onChange={(e) => setBusiness("website", e.target.value)} placeholder="yourcompany.com" inputMode="url" />
                </Field>
                <Field label="Where do you operate?" htmlFor="ob-area" optional>
                  <Input id="ob-area" value={data.business.operatingArea} maxLength={500} onChange={(e) => setBusiness("operatingArea", e.target.value)} placeholder="e.g. Austin, TX and surrounding counties" />
                </Field>
              </div>
              <Field label="What products or services do you offer?" htmlFor="ob-services" optional>
                <Textarea id="ob-services" rows={2} maxLength={2000} value={data.business.services} onChange={(e) => setBusiness("services", e.target.value)} placeholder="e.g. Roof inspections, storm damage repair, gutter replacement" />
              </Field>
              <Field label="Who are your ideal customers?" htmlFor="ob-ideal" optional>
                <Textarea id="ob-ideal" rows={2} maxLength={2000} value={data.business.idealCustomers} onChange={(e) => setBusiness("idealCustomers", e.target.value)} placeholder="e.g. Homeowners with houses older than 10 years" />
              </Field>
            </StepShell>
          )}

          {step === 2 && (
            <StepShell title="What do you want to improve?" subtitle="Pick as many as you like. We'll focus your AI team on these.">
              {errors.goals && <p className="text-[13px] text-danger-ink">{errors.goals}</p>}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="group" aria-label="Goals">
                {BUSINESS_GOALS.map((g, i) => {
                  const on = data.goals.selected.includes(g.id);
                  return (
                    <motion.button
                      key={g.id}
                      type="button"
                      aria-pressed={on}
                      initial={reduce ? false : { opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.03 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => setData((d) => ({ ...d, goals: { ...d.goals, selected: on ? d.goals.selected.filter((x) => x !== g.id) : [...d.goals.selected, g.id] } }))}
                      className={cn(
                        "relative flex items-center gap-3 rounded-2xl border p-4 text-left transition-colors",
                        on ? "border-primary bg-primary-soft/60 ring-2 ring-primary/20" : "border-line bg-surface hover:border-line-strong",
                      )}
                    >
                      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", on ? "bg-primary text-white" : "bg-surface-2 text-ink-2")}>{GOAL_ICONS[g.icon]}</span>
                      <span className="text-[14px] font-medium leading-snug">{g.label}</span>
                      <AnimatePresence>
                        {on && (
                          <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-primary text-white">
                            <Check className="size-3" />
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </motion.button>
                  );
                })}
              </div>
              {data.goals.selected.includes("other") && (
                <Field label="Tell us more" htmlFor="ob-goal-other" optional>
                  <Input id="ob-goal-other" maxLength={300} value={data.goals.other} onChange={(e) => setData((d) => ({ ...d, goals: { ...d.goals, other: e.target.value } }))} />
                </Field>
              )}
            </StepShell>
          )}

          {step === 3 && (
            <StepShell title="How should your AI team communicate?" subtitle="Sensible defaults are already picked. Change anything that doesn't sound like you.">
              <div>
                <p className="mb-2 text-[13px] font-medium text-ink-2">Tone</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {TONES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={data.communication.tone === t}
                      onClick={() => setComm("tone", t)}
                      className={cn("rounded-2xl border p-3.5 text-left transition", data.communication.tone === t ? "border-primary bg-primary-soft/50 ring-2 ring-primary/20" : "border-line bg-surface hover:border-line-strong")}
                    >
                      <span className="flex items-center justify-between text-[14px] font-semibold">
                        {TONE_COPY[t].label} {data.communication.tone === t && <Check className="size-4 text-primary" />}
                      </span>
                      <span className="mt-1 block text-[12.5px] italic text-muted">“{TONE_COPY[t].example}”</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-4">
                <div>
                  <p className="text-[14px] font-medium">Reply length</p>
                  <p className="text-[12.5px] text-muted">{LENGTH_COPY[data.communication.replyLength].description}</p>
                </div>
                <Segmented id="ob-len" ariaLabel="Reply length" value={data.communication.replyLength} onChange={(v: ReplyLength) => setComm("replyLength", v)} options={(["concise", "balanced", "detailed"] as const).map((v) => ({ value: v, label: LENGTH_COPY[v].label }))} />
              </div>
              <Field label="Language" htmlFor="ob-lang">
                <Select id="ob-lang" value={data.communication.language} onChange={(e) => setComm("language", e.target.value as OnboardingData["communication"]["language"])}>
                  {LANGUAGES.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Important company rules" htmlFor="ob-rules" optional>
                <Textarea id="ob-rules" rows={2} maxLength={1500} value={data.communication.companyRules} onChange={(e) => setComm("companyRules", e.target.value)} placeholder="e.g. Always offer a free inspection first" />
              </Field>
              <Field label="What should your AI employees never promise?" htmlFor="ob-never" optional>
                <Textarea id="ob-never" rows={2} maxLength={1000} value={data.communication.neverPromise} onChange={(e) => setComm("neverPromise", e.target.value)} />
                <Chips options={NEVER_PROMISE_CHIPS} value={data.communication.neverPromise} onAdd={(v) => setComm("neverPromise", [data.communication.neverPromise, v].filter(Boolean).join("; "))} />
              </Field>
              <Field label="When should an AI employee ask a human for help?" htmlFor="ob-esc" optional>
                <Input id="ob-esc" maxLength={600} value={data.communication.escalateWhen} onChange={(e) => setComm("escalateWhen", e.target.value)} placeholder="e.g. a customer is upset" />
                <Chips options={ESCALATE_CHIPS} value={data.communication.escalateWhen} onAdd={(v) => setComm("escalateWhen", [data.communication.escalateWhen, v].filter(Boolean).join(", or "))} />
              </Field>
            </StepShell>
          )}

          {step === 4 && (
            <StepShell title="Customize your AI workforce" subtitle="Choose who to set up now. Questions are optional — answer what you know.">
              {errors.workforce && <p className="text-[13px] text-danger-ink">{errors.workforce}</p>}
              <div className="space-y-3">
                {AGENT_ROLES.map((r) => {
                  const enabled = enabledRoles.includes(r.key);
                  const on = enabled && data.workforce.selected.includes(r.key);
                  return (
                    <div key={r.key} className={cn("overflow-hidden rounded-2xl border bg-surface transition", on ? "border-primary/40 shadow-card" : "border-line", !enabled && "opacity-60")}>
                      <button
                        type="button"
                        disabled={!enabled}
                        aria-pressed={on}
                        onClick={() => setData((d) => ({ ...d, workforce: { ...d.workforce, selected: on ? d.workforce.selected.filter((x) => x !== r.key) : [...d.workforce.selected, r.key] } }))}
                        className="flex w-full items-center gap-4 p-4 text-left"
                      >
                        <AgentAvatar role={r} size="lg" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[15px] font-semibold">{r.name}</span>
                          <span className="block text-[13px] text-muted">{enabled ? r.tagline : "Not included in your plan"}</span>
                        </span>
                        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition", on ? "border-primary bg-primary text-white" : "border-line-strong")}>{on && <Check className="size-3.5" />}</span>
                      </button>
                      <AnimatePresence initial={false}>
                        {on && (
                          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} className="overflow-hidden">
                            <div className="space-y-3 border-t border-line bg-surface-2/40 p-4">
                              {r.questions.map((q) => (
                                <Field key={q.id} label={q.label} htmlFor={`ob-${r.key}-${q.id}`} optional>
                                  <Input
                                    id={`ob-${r.key}-${q.id}`}
                                    maxLength={1000}
                                    placeholder={q.placeholder}
                                    value={data.workforce.answers[r.key]?.[q.id] ?? ""}
                                    onChange={(e) =>
                                      setData((d) => ({
                                        ...d,
                                        workforce: { ...d.workforce, answers: { ...d.workforce.answers, [r.key]: { ...(d.workforce.answers[r.key] ?? {}), [q.id]: e.target.value } } },
                                      }))
                                    }
                                  />
                                </Field>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            </StepShell>
          )}

          {step === 5 && (
            <StepShell title="Generate your AI team" subtitle="Here's what we'll use. We turn it into secure, versioned configurations behind the scenes.">
              <div className="space-y-3 rounded-2xl border border-line bg-surface p-5 text-[13.5px]">
                <Row label="Company" value={data.business.companyName} />
                <Row label="What you do" value={data.business.description} />
                <Row label="Goals" value={data.goals.selected.map((g) => BUSINESS_GOALS.find((x) => x.id === g)?.label).filter(Boolean).join(", ")} />
                <Row label="Communication" value={`${TONE_COPY[data.communication.tone].label}, ${LENGTH_COPY[data.communication.replyLength].label.toLowerCase()}, ${data.communication.language}`} />
                <Row label="AI employees" value={data.workforce.selected.map((r) => AGENT_BY_KEY[r as AgentRoleKey]?.shortName).filter(Boolean).join(", ")} />
              </div>
              {completedAt && (
                <p className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-[13px] leading-relaxed text-ink-2" role="note">
                  Your AI team is already set up. Generating again creates a new configuration version for each selected employee from these answers. Earlier versions stay in each employee&apos;s history, so you can roll back any time.
                </p>
              )}
              <ul className="space-y-2 text-[13px] text-muted">
                {["Saves your company profile and starts your Knowledge Center", "Builds a configuration for each employee, wrapped in iAcquire's safety policy", "Asks the iAcquire team to prepare each employee's private environment"].map((t) => (
                  <li key={t} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /> {t}
                  </li>
                ))}
              </ul>
              <Button variant="brand" size="lg" className="w-full" loading={generating} onClick={generate}>
                <Sparkles className="size-4" /> {generating ? "Building your AI team…" : "Generate my AI team"}
              </Button>
            </StepShell>
          )}
        </motion.section>
      </AnimatePresence>

      {step < 5 && (
        <div className="mt-8 flex items-center justify-between">
          <Button variant="ghost" onClick={() => go(step - 1)} disabled={step === 1}>
            <ArrowLeft className="size-4" /> Back
          </Button>
          <Button variant="brand" size="lg" onClick={() => go(step + 1)}>
            Continue <ArrowRight className="size-4" />
          </Button>
        </div>
      )}
      {step === 5 && (
        <div className="mt-6">
          <Button variant="ghost" onClick={() => go(4)}>
            <ArrowLeft className="size-4" /> Back
          </Button>
        </div>
      )}
    </main>
  );
}

function StepShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <div>
        <h1 id="step-title" className="text-[26px] font-semibold tracking-[-0.02em] sm:text-[30px]">
          {title}
        </h1>
        <p className="mt-1.5 text-[14.5px] text-muted">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function Chips({ options, value, onAdd }: { options: string[]; value: string; onAdd: (v: string) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {options
        .filter((o) => !value.toLowerCase().includes(o.toLowerCase()))
        .map((o) => (
          <button key={o} type="button" onClick={() => onAdd(o)} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-ink-2 transition hover:border-primary/30 hover:text-ink">
            <Plus className="size-3" /> {o}
          </button>
        ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[140px_1fr]">
      <span className="text-muted">{label}</span>
      <span className="text-ink">{value || "—"}</span>
    </div>
  );
}

export function GeneratedSummary({ employees }: { employees: GeneratedEmployee[] }) {
  const reduce = useReducedMotion();
  return (
    <main className="mx-auto max-w-4xl px-4 pb-24 pt-6 sm:px-6">
      <motion.div initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="text-center">
        <motion.div initial={reduce ? false : { scale: 0.5 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 260, damping: 15 }} className="mx-auto mb-5 flex size-16 items-center justify-center rounded-3xl bg-success-soft text-success-ink">
          <CheckCircle2 className="size-8" />
        </motion.div>
        <h1 className="text-[30px] font-semibold tracking-[-0.02em]">Your AI team is configured</h1>
        <p className="mx-auto mt-2 max-w-xl text-[14.5px] text-muted">
          Each employee&apos;s configuration is saved and versioned. iAcquire is now preparing their private environments — they&apos;ll come online after a live connection check, and we&apos;ll notify you.
        </p>
      </motion.div>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {employees.map((e, i) => {
          const meta = AGENT_BY_KEY[e.role];
          return (
            <motion.div key={e.role} initial={reduce ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.08 }} className="card-surface rounded-2xl p-5">
              <div className="flex items-center gap-3">
                <AgentAvatar role={meta} size="md" />
                <div>
                  <p className="text-[15px] font-semibold">{meta.name}</p>
                  <p className="text-[12.5px] text-muted">{e.configStatus === "pending_agency_review" ? "Held for a quick iAcquire review" : e.agentStatus === "online" ? "Online" : "Setup in progress"}</p>
                </div>
              </div>
              <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">{e.summary}</p>
              <Link href={`/workforce/${meta.slug}?tab=change`} className="mt-3 inline-flex text-[13px] font-medium text-primary hover:underline">
                Request a change
              </Link>
            </motion.div>
          );
        })}
      </div>
      <div className="mt-10 flex flex-col items-center gap-3">
        <ButtonLink href="/setup" variant="brand" size="lg">
          See my setup progress <ArrowRight className="size-4" />
        </ButtonLink>
        <ButtonLink href="/overview" variant="ghost" size="md">
          Go to my dashboard
        </ButtonLink>
        <p className="text-[13px] text-muted">Tip: add your FAQs and hours in the Knowledge Center while your team is being set up.</p>
      </div>
    </main>
  );
}
