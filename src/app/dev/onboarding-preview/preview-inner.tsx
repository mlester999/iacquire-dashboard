"use client";

import * as React from "react";
import { AdaptiveOnboarding } from "@/components/onboarding/adaptive-onboarding";
import { OnboardingApiProvider, type OnboardingApi } from "@/components/onboarding/onboarding-api";
import { buildReviewModel, computeProgress, resolveCurrentQuestion, submitCheck, validateAnswer, effectiveAnswers, type ConnectionFacts } from "@/lib/onboarding/engine";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import type { AnswerValue, StoredAnswers } from "@/lib/onboarding/types";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import type { OnboardingSession } from "@/server/onboarding/service";

/*
 * DESIGN PREVIEW ONLY. A stand-in for the server so the real questionnaire interface can be reviewed
 * without a backend. State lives in this tab's sessionStorage, which is also what lets a refresh show
 * the resume behaviour. Nothing is sent anywhere, and none of the data is real.
 */

const STORE = "iaq-onboarding-preview";
const FACTS: ConnectionFacts = {
  crmLinked: false, aiEmployeesVerified: 0, aiEmployeesTotal: 6, automationMapped: false,
  channels: { sms: { enabled: false, registration: "not_started" }, whatsapp: { enabled: false, registration: "not_started" }, email: { enabled: false, registration: "not_started" } },
  calendarConnected: false, websiteDomainVerified: false, invitedStaff: 0,
};
const stamp = () => new Date().toISOString();
const row = (value: AnswerValue, source: "user" | "prefill" = "user") => ({ value, skipped: false, source, needsConfirmation: false, updatedAt: stamp() });

function seedAnswers(kind: "empty" | "full"): StoredAnswers {
  const base: StoredAnswers = { "a.business_name": row("Brightside Roofing", "prefill") };
  if (kind === "empty") return base;
  return {
    ...base,
    "a.industry": row("home_services"), "a.business_model": row("local"), "a.description": row("We repair and replace roofs for homeowners in Austin."),
    "a.timezone": row("America/Chicago"), "a.contact_email": row("hello@brightside.test"), "b.goals": row(["more_leads", "more_appointments"]),
    "b.appointments": row(true), "b.website_need": row("new"), "c.channels": row(["sms", "email"]), "c.tone": row("friendly"),
    "d.appt_types": row([{ name: "Free inspection", minutes: "30", mode: "in_person" }]), "d.pricing_policy": row("never"),
    "d.team": row([{ name: "Sam Rivera", email: "sam@brightside.test", role: "sales_rep" }]),
  };
}

function load(kind: "empty" | "full") {
  try {
    const raw = window.sessionStorage.getItem(`${STORE}:${kind}`);
    if (raw) return JSON.parse(raw) as { answers: StoredAnswers; revision: number; current: string | null; submitted: boolean };
  } catch {
    /* private mode: start fresh */
  }
  return { answers: seedAnswers(kind), revision: 0, current: null, submitted: false };
}

const control = {
  fail: false,
  listeners: new Set<(m: string) => void>(),
  log(message: string) {
    this.listeners.forEach((fn) => fn(message));
  },
};

function makeServer(kind: "empty" | "full") {
  const state = load(kind);
  const persist = () => {
    try {
      window.sessionStorage.setItem(`${STORE}:${kind}`, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const api: OnboardingApi = {
    async save(payload) {
      await wait(280);
      if (control.fail) {
        control.log("save → refused (simulated outage)");
        return { ok: false, error: "Couldn't reach the server (simulated outage)." };
      }
      const rejected: Record<string, string> = {};
      const merged = effectiveAnswers(state.answers);
      for (const [id, a] of Object.entries(payload.answers)) {
        const q = QUESTION_BY_ID[id];
        if (!q) continue;
        if (a.skipped) {
          state.answers[id] = { value: null, skipped: true, source: "user", needsConfirmation: false, updatedAt: stamp() };
          continue;
        }
        const res = validateAnswer(q, a.value, { ...merged, [id]: a.value as AnswerValue });
        if (!res.ok) rejected[id] = res.error;
        else {
          const source = a.source ?? "user";
          state.answers[id] = { value: res.value, skipped: false, source, needsConfirmation: Boolean(q.sensitive) && source !== "user" && !a.confirmed, updatedAt: stamp() };
        }
      }
      if (Object.keys(payload.answers).some((id) => id !== "f.review") && !("f.review" in payload.answers) && state.answers["f.review"]?.value === true) {
        state.answers["f.review"] = row(false);
      }
      if (payload.currentQuestionId) state.current = resolveCurrentQuestion(state.answers, payload.currentQuestionId);
      const staleBase = payload.baseRevision !== undefined && payload.baseRevision !== state.revision;
      state.revision += 1;
      persist();
      control.log(`save → ok, revision ${state.revision}, resume at ${state.current}`);
      return { ok: true, data: { revision: state.revision, rejected, staleBase } };
    },
    async suggest(id) {
      await wait(700);
      if (id === "a.description") {
        return { ok: true, data: { questionId: id, value: "Brightside Roofing repairs and replaces roofs for homeowners across the Austin area, starting with a free inspection.", basis: "your_answers", reason: "Based on your business name, industry and location.", source: "ai_suggestion", needsConfirmation: false } };
      }
      if (id === "e.faqs") {
        return { ok: true, data: { questionId: id, value: [{ question: "Do you offer free inspections?", answer: "Yes, every roof gets a free inspection first." }], basis: "your_website", reason: "Found on your FAQ page.", source: "website_analysis", needsConfirmation: true } };
      }
      return { ok: false, error: "The AI assistant isn't connected yet. You can still answer this yourself." };
    },
    async readWebsite(url) {
      await wait(900);
      return { ok: true, data: { origin: new URL(/^https?:/.test(url) ? url : `https://${url}`).origin, analyzedAt: stamp(), suggestions: [
        { questionId: "a.description", value: "Family-owned roofing in Austin since 2009.", evidence: "Your homepage's own description" },
        { questionId: "e.faqs", value: [{ question: "Do you work weekends?", answer: "Yes, by appointment." }], evidence: "1 question found on your website" },
      ] } };
    },
    async review() {
      await wait(400);
      return { ok: true, data: buildReviewModel(state.answers, FACTS, [...AGENT_ROLE_KEYS]) };
    },
    async submit() {
      await wait(900);
      const check = submitCheck(state.answers);
      if (!check.canSubmit) return { ok: false, error: check.blockers[0] ?? "Finish the remaining questions first." };
      state.submitted = true;
      persist();
      return { ok: true, data: {} };
    },
    async uploadImage(assetKind, file) {
      await wait(500);
      const url = URL.createObjectURL(file);
      return { ok: true, data: { id: crypto.randomUUID(), kind: assetKind, altText: "", width: null, height: null, processingStatus: assetKind === "logo" ? "unsupported" : "none", processingNote: assetKind === "logo" ? "Preview only: background removal is not run here." : null, useVariant: "original", hasProcessed: false, createdAt: stamp(), url, processedUrl: null } };
    },
    async uploadDocument(file) {
      await wait(500);
      return { ok: true, data: { id: crypto.randomUUID(), filename: file.name } };
    },
    async removeAsset() {
      return { ok: true, data: {} };
    },
    async setAssetVariant() {
      return { ok: true, data: {} };
    },
  };
  return {
    api,
    state,
    reopen() {
      state.submitted = false;
      persist();
    },
  };
}

export default function PreviewInner({ seed }: { seed: "empty" | "full" }) {
  const [fail, setFail] = React.useState(false);
  const [log, setLog] = React.useState<string[]>([]);
  React.useEffect(() => {
    const listener = (m: string) => setLog((l) => [m, ...l].slice(0, 8));
    control.listeners.add(listener);
    return () => void control.listeners.delete(listener);
  }, []);
  const [server] = React.useState(() => makeServer(seed));
  const [done, setDone] = React.useState(server.state.submitted);
  const [instance, setInstance] = React.useState(0);

  const session: OnboardingSession = React.useMemo(
    () => ({
      questionnaireVersion: 2, status: "draft", revision: server.state.revision, currentQuestionId: resolveCurrentQuestion(server.state.answers, server.state.current),
      answers: server.state.answers, progress: computeProgress(server.state.answers), completedAt: null, submittedAt: null, hasUnsubmittedChanges: false,
      enabledRoles: [...AGENT_ROLE_KEYS], websiteAnalysis: null,
    }),
    // The session is only the starting point; the interface owns state afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instance],
  );

  const reset = () => {
    try {
      window.sessionStorage.removeItem(`${STORE}:${seed}`);
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  return (
    <div className="app-backdrop grain min-h-dvh">
      <div className="sticky top-0 z-40 border-b border-warning/30 bg-warning-soft px-4 py-2 text-center text-[12.5px] font-medium text-warning-ink">
        Design preview — sample data for Brightside Roofing, saved only in this browser tab. Not a real workspace.{" "}
        <label className="ml-2 inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={fail}
            onChange={(e) => {
              control.fail = e.target.checked;
              setFail(e.target.checked);
            }}
          />{" "}
          Simulate save failure
        </label>
        <button type="button" onClick={reset} className="ml-3 underline">
          Reset
        </button>
        <a className="ml-3 underline" href={`?seed=${seed === "full" ? "empty" : "full"}`}>
          {seed === "full" ? "Start empty" : "Load a nearly finished setup"}
        </a>
      </div>
      <OnboardingApiProvider value={server.api}>
        {done ? (
          <main className="mx-auto max-w-xl px-4 py-16 text-center">
            <h1 className="text-2xl font-semibold">Approved (preview)</h1>
            <p className="mt-2 text-muted">In the real product you would now land on the Setup Center.</p>
            <button type="button" className="mt-4 underline" onClick={() => {
                server.reopen();
                setDone(false);
                setInstance((n) => n + 1);
              }}>
              Back to the questionnaire
            </button>
          </main>
        ) : (
          <AdaptiveOnboarding key={instance} session={session} assets={[]} documents={[]} onSubmitted={() => setDone(true)} onExit={() => control.log("Save & exit pressed → would go to the dashboard")} />
        )}
      </OnboardingApiProvider>
      <details className="mx-auto mb-8 max-w-6xl px-4 text-[12px] text-muted sm:px-6">
        <summary className="cursor-pointer">Sample server log</summary>
        <ul className="mt-2 space-y-1 font-mono">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
      </details>
    </div>
  );
}
