"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Badge, Field, Select } from "@/components/ui/primitives";
import { CHANNEL_LABELS } from "@/lib/messaging";
import type { RequestReviewConfig, WorkflowStep } from "@/lib/crm/workflow/spec";
import { SinglePick, Toggle } from "@/components/crm/workflows/pickers";
import type { EditorOptions } from "@/components/crm/workflows/types";
import { isReviewTemplate } from "@/components/crm/reviews/model";

/**
 * The settings of a "Request a review" workflow step: one approved service template that has {{review.link}}, and business hours. The
 * same shape as the other step editors' props (src/components/crm/workflows/step-panel.tsx), so the panel renders it like any kind.
 */
export function RequestReviewFields({ step, options, errorAt, config, replace, base, readOnly }: {
  step: WorkflowStep;
  options: EditorOptions;
  errorAt: (path: string) => string | null;
  config: (patch: Record<string, unknown>) => void;
  replace: (cfg: WorkflowStep["config"]) => void;
  base: string;
  readOnly?: boolean;
}) {
  const s = step.config as RequestReviewConfig;
  const usable = options.templates.filter(isReviewTemplate);
  const chosen = options.templates.find((t) => t.id === s.templateId) ?? null;
  const byChannel = (["sms", "whatsapp", "email"] as const).map((c) => ({ label: CHANNEL_LABELS[c], ids: usable.filter((t) => t.channel === c).map((t) => t.id) })).filter((g) => g.ids.length);
  // A review request is the default and is stored as no "mode" at all, so versions published before surveys existed keep exactly their content.
  const setMode = (mode: string) => {
    const next: Record<string, unknown> = { ...s };
    delete next.mode;
    delete next.scale;
    replace((mode === "survey" ? { ...next, mode: "survey" } : next) as RequestReviewConfig);
  };
  return (
    <>
      <Field label="What to send" htmlFor="wf-review-mode" error={errorAt("config.scale")} hint="Both use the same private page with your public review links. A survey asks its question first.">
        <Select id="wf-review-mode" value={s.mode ?? "review"} disabled={readOnly} onChange={(e) => setMode(e.target.value)}>
          <option value="review">A request for a review</option>
          <option value="survey">A short satisfaction survey</option>
        </Select>
      </Field>
      {s.mode === "survey" && (
        <Field label="The survey's question" htmlFor="wf-review-scale">
          <Select
            id="wf-review-scale"
            value={s.scale ?? "csat5"}
            disabled={readOnly}
            onChange={(e) => replace({ ...s, scale: e.target.value === "nps10" ? "nps10" : undefined } as RequestReviewConfig)}
          >
            <option value="csat5">How was your experience? (1 to 5)</option>
            <option value="nps10">How likely are you to recommend us? (0 to 10)</option>
          </Select>
        </Field>
      )}
      <Field
        label="Review request template"
        htmlFor="wf-review-template"
        error={errorAt("config.templateId") ?? errorAt("config.contentHash") ?? errorAt("config.channel")}
        hint={!usable.length ? undefined : "Approved service templates that contain {{review.link}}. Each contact gets their own private link."}
      >
        <SinglePick
          id="wf-review-template"
          value={s.templateId}
          disabled={readOnly}
          onChange={(id) => {
            const t = usable.find((x) => x.id === id);
            if (!t) return replace({ ...s, templateId: "", contentHash: "", channel: s.channel } as RequestReviewConfig);
            replace({ ...s, templateId: t.id, contentHash: t.contentHash, channel: t.channel as RequestReviewConfig["channel"] });
          }}
          options={usable.map((t) => ({ id: t.id, label: t.name }))}
          groups={byChannel}
          placeholder={usable.length ? "Choose a review request template" : "No review request templates yet"}
        />
        {!usable.length && (
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Write a service template with <span className="font-mono text-[12px]">{"{{review.link}}"}</span> and approve it first. <Link href={`${base}/templates`} className="font-medium text-primary hover:underline">Templates</Link>
          </p>
        )}
      </Field>
      {chosen && (
        <div className="space-y-2 rounded-2xl border border-line bg-surface-2/50 p-3">
          <p className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-muted">
            <Badge tone="success"><ShieldCheck className="size-3" aria-hidden />Approved v{chosen.version}</Badge>
            {CHANNEL_LABELS[chosen.channel]} · Service message
          </p>
          {chosen.subject && <p className="text-[14px] font-medium text-ink">{chosen.subject}</p>}
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink-2">{chosen.body}</p>
          <p className="text-[12px] leading-relaxed text-muted">
            Sent only to contacts who agreed to messages by {CHANNEL_LABELS[chosen.channel]}, who haven&apos;t opted out and weren&apos;t asked in the last 30 days, outside quiet hours, within sending limits and your credits. Everyone asked sees the same public review links.
          </p>
        </div>
      )}
      <Toggle id="wf-review-hours" label="Only during business hours" hint="Quiet hours always apply; this also holds requests outside your business hours." checked={s.businessHoursOnly} disabled={readOnly} onChange={(v) => config({ businessHoursOnly: v })} />
    </>
  );
}
