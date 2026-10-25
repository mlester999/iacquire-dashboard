"use client";

import * as React from "react";
import { AlertCircle, AlertTriangle, Braces, CheckCircle2, Info, Mail, MessageCircle, MessageSquareText, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import {
  renderTemplate, splitTokens, TEMPLATE_TOKENS, TOKEN_GROUP_LABELS, tokenText, type TemplateIssue, type TemplateValidation, type TokenGroup, type TokenValues,
  anyTokenLabel, customValueTokenKey, CUSTOM_VALUES_GROUP_LABEL, type AnyTokenKey, type CustomValueTokenDef,
} from "@/lib/messaging/tokens";
import { useCustomValueTokens } from "@/components/crm/custom-values/token-catalog";

// Small pieces shared by the template editor, the canned replies editor and the lists.

export const CHANNEL_ICON: Record<Channel, React.ComponentType<{ className?: string }>> = { sms: MessageSquareText, whatsapp: MessageCircle, email: Mail };
export const CHANNEL_ORDER: Channel[] = ["email", "sms", "whatsapp"];

export function ChannelLabel({ channel, className }: { channel: Channel | null; className?: string }) {
  if (!channel) return <span className={cn("inline-flex items-center gap-1.5 text-[12.5px] text-muted", className)}>Any channel</span>;
  const Icon = CHANNEL_ICON[channel];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12.5px] text-ink-2", className)}>
      <Icon className="size-3.5 text-muted" aria-hidden />
      {CHANNEL_LABELS[channel]}
    </span>
  );
}

export function TemplateStatusBadge({ status, approvedVersion }: { status: "draft" | "approved" | "archived"; approvedVersion: number | null }) {
  if (status === "approved") return <Badge tone="success"><CheckCircle2 className="size-3" aria-hidden />Approved v{approvedVersion}</Badge>;
  if (status === "archived") return <Badge>Archived</Badge>;
  return <Badge tone="warning">Draft</Badge>;
}

/** Text with its {{tokens}} shown as chips: known tokens by label, unknown ones in red. Purely visual; the raw text is what is stored. */
export function TokenHighlight({ text, className }: { text: string; className?: string }) {
  // Configuration values count as known only when this workspace has them (when the screen loaded them).
  const customValues = useCustomValueTokens();
  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {splitTokens(text, customValues).map((p, i) =>
        p.token ? (
          <span
            key={i}
            className={cn(
              "mx-px rounded-md px-1 py-px font-mono text-[0.86em]",
              p.token.known ? "bg-primary-soft text-primary-ink" : "bg-danger-soft text-danger-ink line-through decoration-danger/60",
            )}
            title={p.token.known ? anyTokenLabel(p.token.key, customValues) : "Not a token iAcquire knows"}
          >
            {p.text}
          </span>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ),
      )}
    </span>
  );
}

/**
 * The template as a customer would read it, with each filled token marked and each missing one shown as a labelled gap. Every placeholder is
 * run through the same renderer that sending uses, so the words here are exactly the words that would go out.
 */
export function RenderedText({ text, values, singleLine, customValues: given }: {
  text: string;
  values: TokenValues;
  singleLine?: boolean;
  /** The workspace's configuration values (with their current values). Default: the ones the screen provides. */
  customValues?: readonly CustomValueTokenDef[] | null;
}) {
  const provided = useCustomValueTokens();
  const customValues = given === undefined ? provided : given;
  return (
    <span className={cn("break-words", singleLine ? "" : "whitespace-pre-wrap")}>
      {splitTokens(text, customValues).map((p, i) => {
        if (!p.token) return <React.Fragment key={i}>{singleLine ? p.text.replace(/\s*[\r\n]+\s*/g, " ") : p.text}</React.Fragment>;
        const r = renderTemplate(p.text, values, { singleLine, customValues });
        const label = anyTokenLabel(p.token.key, customValues);
        // An optional configuration value that is empty renders as nothing, exactly as it would be sent.
        if (r.ok) return r.text ? <mark key={i} className="rounded bg-primary-soft/70 px-0.5 text-inherit" title={label}>{r.text}</mark> : null;
        return (
          <mark key={i} className="rounded border border-dashed border-danger/50 bg-danger-soft/60 px-1 text-[0.9em] text-danger-ink">
            {label ? `${label} missing` : `Unknown ${p.text}`}
          </mark>
        );
      })}
    </span>
  );
}

/** Inserts a token into a text field at the caret (or replacing the selection), then puts the caret after it. */
export function insertAtCaret(el: HTMLInputElement | HTMLTextAreaElement | null, current: string, insert: string, set: (v: string) => void) {
  const start = el?.selectionStart ?? current.length;
  const end = el?.selectionEnd ?? current.length;
  const next = current.slice(0, start) + insert + current.slice(end);
  set(next);
  requestAnimationFrame(() => {
    if (!el) return;
    el.focus();
    const at = start + insert.length;
    el.setSelectionRange(at, at);
  });
}

const GROUPS = Object.keys(TOKEN_GROUP_LABELS) as TokenGroup[];

/**
 * Where keyboard focus goes when a menu or popover that inserts text closes. After a pick, the field the text went into takes focus (so
 * Radix must not move it back to the trigger); after Escape or a click outside, Radix returns it to the trigger as usual. Preventing that
 * return unconditionally left focus on <body> after Escape.
 */
export function pickFocusGuard() {
  let picked = false;
  return {
    markPicked() {
      picked = true;
    },
    onCloseAutoFocus(e: { preventDefault(): void }) {
      if (picked) e.preventDefault();
      picked = false;
    },
  };
}

/** A menu of every token, grouped, that inserts the chosen one where the person was typing. The workspace's configuration values come last. */
export function TokenPicker({ onPick, disabled, label = "Insert token" }: { onPick: (key: AnyTokenKey) => void; disabled?: boolean; label?: string }) {
  // After a pick the text field takes focus at the inserted token (insertAtCaret); after Escape, focus goes back to this button.
  const [focus] = React.useState(pickFocusGuard);
  const customValues = useCustomValueTokens() ?? [];
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button type="button" variant="secondary" size="sm" disabled={disabled}><Braces className="size-3.5" aria-hidden />{label}</Button>
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[min(420px,70dvh)] w-72 overflow-y-auto" onCloseAutoFocus={focus.onCloseAutoFocus}>
        {GROUPS.map((g, gi) => (
          <React.Fragment key={g}>
            {gi > 0 && <MenuSeparator />}
            <MenuLabel>{TOKEN_GROUP_LABELS[g]}</MenuLabel>
            {TEMPLATE_TOKENS.filter((t) => t.group === g).map((t) => (
              <MenuItem key={t.key} onSelect={() => { focus.markPicked(); onPick(t.key); }} className="flex-col items-start gap-0.5">
                <span className="text-[13px] text-ink">{t.label}</span>
                <span className="font-mono text-[12px] text-muted">{tokenText(t.key)}</span>
              </MenuItem>
            ))}
          </React.Fragment>
        ))}
        {customValues.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>{CUSTOM_VALUES_GROUP_LABEL}</MenuLabel>
            {customValues.map((v) => {
              const key = customValueTokenKey(v.key);
              const emptyRequired = v.required && !(v.value ?? "").trim();
              return (
                <MenuItem key={key} onSelect={() => { focus.markPicked(); onPick(key); }} className="flex-col items-start gap-0.5">
                  <span className="text-[13px] text-ink">{v.label}{v.group ? <span className="text-muted"> · {v.group}</span> : null}</span>
                  <span className="break-all font-mono text-[12px] text-muted">{tokenText(key)}</span>
                  {emptyRequired && <span className="text-[12px] text-warning-ink">Required and still empty: messages using it are held until it&apos;s filled in.</span>}
                </MenuItem>
              );
            })}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

const ISSUE_STYLE = {
  error: { icon: AlertCircle, cls: "text-danger-ink", label: "Must fix" },
  warning: { icon: AlertTriangle, cls: "text-warning-ink", label: "Check" },
  info: { icon: Info, cls: "text-muted", label: "Note" },
} as const;

/** What a screen reader hears about the checks: only how many must be fixed or checked, never the details that change as you type. */
export function checksSummary(check: Pick<TemplateValidation, "errors" | "warnings">): string {
  const e = check.errors.length;
  const w = check.warnings.length;
  const fix = `${e} ${e === 1 ? "problem" : "problems"} to fix`;
  const look = `${w} ${w === 1 ? "thing" : "things"} to check`;
  if (e && w) return `${fix}, ${look}.`;
  if (e) return `${fix}.`;
  if (w) return `${look}.`;
  return "No problems found.";
}

/**
 * The live checks under the editor. Errors block saving; warnings and notes never do. The list itself is plain text (the editor's field
 * points at it with aria-describedby); only a change in the number of problems is announced, half a second after typing stops, so the
 * SMS segment estimate that changes with every character is never read out on each keystroke.
 */
export function ValidationList({ check, onFix }: { check: TemplateValidation; onFix?: (issue: TemplateIssue) => void }) {
  const issues = [...check.errors, ...check.warnings, ...check.info];
  const summary = checksSummary(check);
  const [announced, setAnnounced] = React.useState(summary);
  React.useEffect(() => {
    const t = window.setTimeout(() => setAnnounced(summary), 500);
    return () => window.clearTimeout(t);
  }, [summary]);
  return (
    <div className="space-y-1.5">
      <p role="status" aria-live="polite" className="sr-only">{announced}</p>
      {!check.errors.length && !check.warnings.length && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-success-ink"><CheckCircle2 className="size-3.5" aria-hidden />No problems found.</p>
      )}
      <ul className="space-y-1.5">
        {issues.map((i, n) => {
          const s = ISSUE_STYLE[i.level];
          const Icon = s.icon;
          return (
            <li key={`${i.code}-${n}`} className={cn("flex items-start gap-2 text-[12.5px] leading-relaxed", s.cls)}>
              <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="sr-only">{s.label}: </span>
                {i.field === "subject" && <span className="font-medium">Subject: </span>}
                {i.message}
              </span>
              {onFix && i.suggestion && i.token && (
                <button type="button" onClick={() => onFix(i)} className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-primary hover:bg-primary-soft">
                  <Wand2 className="size-3" aria-hidden />Use {tokenText(i.suggestion)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Replaces every occurrence of a mistyped placeholder (exactly as written) with the suggested token. An occurrence that is part of a longer
 * brace run is left alone, so fixing "{contact.first_name}" never touches a correct "{{contact.first_name}}" elsewhere in the text.
 */
export function applySuggestion(text: string, issue: TemplateIssue): string {
  if (!issue.token || !issue.suggestion) return text;
  const escaped = issue.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<!\\{)${escaped}(?!\\})`, "g"), tokenText(issue.suggestion));
}
