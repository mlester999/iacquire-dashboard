"use client";

// The one small piece of browser code a native form on a website uses. Without it the form works fully (every question is shown, with
// a note saying when to answer it, and the server decides what applies). With it, questions whose conditions don't hold are hidden and
// left out of the post, and the page the visitor was on and where they came from are noted for attribution (only what the browser has).
import * as React from "react";
import { shownQuestions, type WithVisibility } from "@/lib/crm/forms/visibility";
import type { PublicHiddenField } from "@/lib/crm/forms/spec";

const NONE: PublicHiddenField[] = [];

export function SiteFormLogic({ questions, hidden = NONE }: { questions: WithVisibility[]; hidden?: PublicHiddenField[] }) {
  const anchor = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    const note = (name: string, value: string) => {
      const input = form.querySelector<HTMLInputElement>(`input[type=hidden][name="${name}"]`);
      if (input && !input.value) input.value = value.slice(0, 500);
    };
    note("_l", `${window.location.pathname}${window.location.search}`);
    note("_r", document.referrer);
    form.querySelectorAll<HTMLElement>("[data-q-when]").forEach((n) => { n.hidden = true; });
    const apply = () => {
      const fd = new FormData(form);
      // Hidden attribution values come from the same landing page and referrer the form posts, compared with this page's host, as the
      // server works them out: a question that depends on one shows exactly when the server will ask for it.
      const text = (name: string) => { const v = fd.get(name); return typeof v === "string" && v ? v : null; };
      const shown = shownQuestions(questions, hidden, (name) => fd.getAll(name).filter((v): v is string => typeof v === "string"), { landing: text("_l"), referrer: text("_r") }, window.location.hostname);
      for (const q of questions) {
        if (!q.visibleWhen?.conditions.length) continue;
        const wrap = form.querySelector<HTMLElement>(`[data-q="${q.key}"]`);
        if (!wrap) continue;
        const show = shown.has(q.key);
        wrap.hidden = !show;
        wrap.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea").forEach((c) => {
          c.disabled = !show;
          if (c.dataset.req) c.required = show;
        });
      }
    };
    apply();
    form.addEventListener("input", apply);
    form.addEventListener("change", apply);
    return () => {
      form.removeEventListener("input", apply);
      form.removeEventListener("change", apply);
    };
  }, [questions, hidden]);
  return <span ref={anchor} hidden />;
}
