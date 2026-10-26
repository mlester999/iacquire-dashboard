"use client";

import * as React from "react";
import { Info, ShieldAlert, TriangleAlert, XCircle } from "lucide-react";
import { Label } from "@/components/ui/primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import type { FieldGuidance } from "@/lib/employee-field-guidance";
import { cn } from "@/lib/utils";

export interface FieldIssue {
  tone: "warning" | "danger" | "info";
  title: string;
  detail: string;
  /** A plain-English next step. Never exposes detection rules. */
  fix?: string;
}

function describedBy(...ids: Array<string | false | null | undefined>) {
  return ids.filter(Boolean).join(" ") || undefined;
}

function FieldHelp({ id, label, guidance }: { id: string; label: string; guidance: FieldGuidance }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`More information about ${label}`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-faint transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(21rem,calc(100vw-2rem))] p-4">
        <p id={`${id}-help-title`} className="text-[14px] font-semibold text-ink">{label}</p>
        {guidance.info && <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{guidance.info}</p>}
        {guidance.example && (
          <div className="mt-3 rounded-xl border border-line bg-surface-2/70 p-2.5">
            <p className="text-[12px] font-semibold uppercase tracking-[.12em] text-faint">Example answer</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{guidance.example}</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function FieldIssues({ id, issues }: { id: string; issues: FieldIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="space-y-1.5">
      {issues.map((issue, index) => {
        const danger = issue.tone === "danger";
        const info = issue.tone === "info";
        const Icon = danger ? XCircle : info ? Info : TriangleAlert;
        return (
          <div
            key={`${issue.title}-${index}`}
            id={`${id}-issue-${index}`}
            role={danger ? "alert" : "status"}
            className={cn(
              "flex items-start gap-2 rounded-xl border p-2.5 text-[12px] leading-relaxed",
              danger && "border-danger/25 bg-danger-soft/40 text-danger-ink",
              issue.tone === "warning" && "border-warning/30 bg-warning-soft/40 text-warning-ink",
              info && "border-line bg-surface-2/70 text-ink-2",
            )}
          >
            <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="font-semibold">{issue.title}</p>
              <p className={cn("mt-0.5", !danger && !info && "text-ink-2")}>{issue.detail}</p>
              {issue.fix && (
                <p className={cn("mt-1", danger ? "text-danger-ink" : "text-muted")}>
                  <span className="font-medium">How to fix: </span>
                  {issue.fix}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FieldHeader({
  id,
  label,
  required,
  optional,
  guidance,
}: {
  id: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  guidance?: FieldGuidance;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {guidance && <FieldHelp id={id} label={label} guidance={guidance} />}
      </div>
      {required ? (
        <span className="text-[12px] font-medium text-danger-ink">Required</span>
      ) : optional ? (
        <span className="text-[12px] text-faint">Optional</span>
      ) : null}
    </div>
  );
}

export function GuidedField({
  id,
  label,
  guidance,
  required = false,
  optional = false,
  error,
  issues = [],
  charLimit,
  valueLength,
  children,
  className,
}: {
  id: string;
  label: string;
  guidance: FieldGuidance;
  required?: boolean;
  optional?: boolean;
  error?: string | null;
  issues?: FieldIssue[];
  charLimit?: number;
  valueLength?: number;
  children: React.ReactElement<{ id?: string; placeholder?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
  className?: string;
}) {
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const countId = `${id}-count`;
  const remaining = typeof charLimit === "number" && typeof valueLength === "number" ? charLimit - valueLength : null;
  const showCount = remaining !== null && remaining <= Math.max(80, Math.round((charLimit ?? 0) * 0.15));
  const invalid = Boolean(error);
  const described = describedBy(
    descriptionId,
    invalid && errorId,
    showCount && countId,
    ...issues.map((_, index) => `${id}-issue-${index}`),
  );

  const child = React.isValidElement(children)
    ? React.cloneElement(children, {
        id,
        placeholder: children.props.placeholder ?? guidance.example,
        "aria-describedby": describedBy(children.props["aria-describedby"], described),
        "aria-invalid": invalid || children.props["aria-invalid"] || undefined,
      })
    : children;

  return (
    <div className={cn("space-y-2", className)} data-guided-field={id}>
      <FieldHeader id={id} label={label} required={required} optional={optional} guidance={guidance} />
      <p id={descriptionId} className="text-[13px] leading-relaxed text-muted">{guidance.description}</p>
      {child}
      {invalid && (
        <p id={errorId} role="alert" className="text-[13px] leading-relaxed text-danger-ink">
          {error}
        </p>
      )}
      <FieldIssues id={id} issues={issues} />
      {showCount && (
        <p id={countId} className={cn("text-right text-[12px]", remaining !== null && remaining < 20 ? "text-warning-ink" : "text-faint")}>
          {remaining} characters left
        </p>
      )}
    </div>
  );
}

export function GuidedChoiceField({
  id,
  label,
  guidance,
  optional = true,
  issues = [],
  children,
  className,
}: {
  id: string;
  label: string;
  guidance: FieldGuidance;
  optional?: boolean;
  issues?: FieldIssue[];
  children: React.ReactNode;
  className?: string;
}) {
  const descriptionId = `${id}-description`;
  return (
    <fieldset
      id={id}
      data-guided-field={id}
      className={cn("min-w-0 space-y-2 scroll-mt-28 border-0 p-0", className)}
      aria-describedby={describedBy(descriptionId, ...issues.map((_, index) => `${id}-issue-${index}`))}
    >
      <legend className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[14px] font-medium text-ink-2">{label}</span>
          <FieldHelp id={id} label={label} guidance={guidance} />
        </span>
        {optional && <span className="text-[12px] text-faint">Optional</span>}
      </legend>
      <p id={descriptionId} className="text-[13px] leading-relaxed text-muted">{guidance.description}</p>
      {children}
      <FieldIssues id={id} issues={issues} />
    </fieldset>
  );
}

export function GuidedSwitch({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  issues = [],
  disabled = false,
  offLabel = "Off",
  onLabel = "On",
  className,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  issues?: FieldIssue[];
  disabled?: boolean;
  offLabel?: string;
  onLabel?: string;
  className?: string;
}) {
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return (
    <div id={id} data-guided-field={id} className={cn("rounded-2xl border border-line bg-surface p-3.5 scroll-mt-28", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p id={labelId} className="text-[14px] font-medium text-ink">{label}</p>
          <p id={descriptionId} className="mt-1 text-[12px] leading-relaxed text-muted">{description}</p>
          <p className="mt-1.5 text-[12px] font-medium text-faint" aria-hidden>{checked ? onLabel : offLabel}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          disabled={disabled}
          onClick={() => onCheckedChange(!checked)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50",
            checked ? "bg-primary" : "bg-surface-3",
          )}
        >
          <span
            aria-hidden
            className={cn("block size-5 rounded-full bg-white shadow-md transition-transform duration-200", checked ? "translate-x-[22px]" : "translate-x-0.5")}
          />
        </button>      </div>
      <div className="mt-2">
        <FieldIssues id={id} issues={issues} />
      </div>
    </div>
  );
}

/**
 * A compact, accessible summary of a change decision. Used before saving and after the server has
 * made the authoritative decision.
 */
export function ChangeDecisionNotice({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: "success" | "warning" | "danger" | "info";
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const Icon = tone === "danger" ? ShieldAlert : tone === "warning" ? TriangleAlert : Info;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-2xl border p-3.5 text-[13px] leading-relaxed",
        tone === "success" && "border-success/25 bg-success-soft/40 text-success-ink",
        tone === "warning" && "border-warning/30 bg-warning-soft/40 text-warning-ink",
        tone === "danger" && "border-danger/25 bg-danger-soft/40 text-danger-ink",
        tone === "info" && "border-line bg-surface-2/70 text-ink-2",
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-1 space-y-1.5">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
