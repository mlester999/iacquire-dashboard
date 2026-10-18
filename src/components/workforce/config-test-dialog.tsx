"use client";

import * as React from "react";
import { AlertCircle, Check, FlaskConical, Info, Loader2, RotateCcw, Send, ShieldAlert, Square } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Textarea } from "@/components/ui/primitives";
import { previewConfigAction } from "@/app/actions/workforce";
import type { AgentSettings } from "@/lib/agent-settings";
import type { AgentRoleKey } from "@/lib/agents";
import type { ConfigPreviewEvent, ConfigPreviewSummary, PreviewMessage } from "@/lib/workforce-types";
import { cn } from "@/lib/utils";

async function* readPreviewEvents(res: Response): AsyncGenerator<ConfigPreviewEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as ConfigPreviewEvent;
      } catch {
        // Ignore a malformed frame; the stream is untrusted.
      }
    }
  }
}

interface TestMessage extends PreviewMessage {
  id: string;
}

export function ConfigTestDialog({
  open,
  onOpenChange,
  role,
  agentName,
  draft,
  activeVersion,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: AgentRoleKey;
  agentName: string;
  draft: AgentSettings;
  activeVersion: number | null;
}) {
  const [summary, setSummary] = React.useState<ConfigPreviewSummary | null>(null);
  const [summaryError, setSummaryError] = React.useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = React.useState(false);
  const [messages, setMessages] = React.useState<TestMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [activity, setActivity] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [unavailable, setUnavailable] = React.useState<string | null>(null);
  const [stopped, setStopped] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    const load = async () => {
      setLoadingSummary(true);
      setSummaryError(null);
      const res = await previewConfigAction(role, draft);
      if (!active) return;
      if (res.ok) setSummary(res.data);
      else setSummaryError(res.error);
      setLoadingSummary(false);
    };
    void load();
    return () => {
      active = false;
    };
    // The draft is intentionally compared when the dialog is opened; edits are made in the Configure tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role]);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      abortRef.current?.abort();
      abortRef.current = null;
      setRunning(false);
      setActivity(null);
    }
    onOpenChange(next);
  };

  React.useEffect(() => {
    if (open) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, activity, open]);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setInput("");
    setError(null);
    setUnavailable(null);
    setStopped(false);
    setRunning(false);
    setActivity(null);
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setActivity(null);
    setStopped(true);
  };

  const send = async () => {
    const content = input.trim();
    if (!content || running) return;
    setError(null);
    setUnavailable(null);
    setStopped(false);
    const next = [...messages, { id: `u-${crypto.randomUUID()}`, role: "user" as const, content }];
    setMessages(next);
    setInput("");
    setRunning(true);
    setActivity("Preparing the test session…");
    const controller = new AbortController();
    abortRef.current = controller;
    let res: Response;
    try {
      res = await fetch("/api/workforce/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, settings: draft, messages: next.map(({ role: r, content: c }) => ({ role: r, content: c })) }),
        signal: controller.signal,
      });
    } catch {
      setRunning(false);
      setActivity(null);
      if (!controller.signal.aborted) setError("Network problem — the test message wasn't sent.");
      return;
    }
    if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
      const data = await res.json().catch(() => ({ error: "The test couldn't start." }));
      setRunning(false);
      setActivity(null);
      setError(data.error ?? "The test couldn't start.");
      return;
    }
    let assistantId: string | null = null;
    try {
      for await (const event of readPreviewEvents(res)) {
        switch (event.type) {
          case "prepared":
            setSummary(event.data);
            break;
          case "started":
            setActivity("Waiting for the first words…");
            break;
          case "delta": {
            setActivity(null);
            if (!assistantId) {
              assistantId = `a-${crypto.randomUUID()}`;
              const id = assistantId;
              setMessages((prev) => [...prev, { id, role: "assistant", content: event.text }]);
            } else {
              const id = assistantId;
              setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + event.text } : m)));
            }
            break;
          }
          case "activity":
            setActivity(event.label);
            break;
          case "done": {
            setActivity(null);
            if (!assistantId) {
              assistantId = `a-${crypto.randomUUID()}`;
              const id = assistantId;
              setMessages((prev) => [...prev, { id, role: "assistant", content: event.content }]);
            } else {
              const id = assistantId;
              setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: event.content } : m)));
            }
            break;
          }
          case "error":
            setError(event.message);
            break;
          case "cancelled":
            setStopped(true);
            break;
          case "unavailable":
            setUnavailable(event.message);
            break;
        }
      }
    } catch {
      if (!controller.signal.aborted) setError("The connection to the test session dropped. Nothing was saved.");
    } finally {
      setRunning(false);
      setActivity(null);
      abortRef.current = null;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={`Test ${agentName}'s draft`}
      description="A real provider test with the draft configuration. It never changes the live employee, saves a conversation or applies a version."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="ghost" onClick={reset} disabled={running || (!messages.length && !error && !unavailable)}>
            <RotateCcw className="size-4" aria-hidden /> Start over
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-line bg-surface-2/60 p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <FlaskConical className="size-4 text-violet" aria-hidden />
            <p className="text-[13px] font-semibold">Isolated test session</p>
            <span className="rounded-full border border-line bg-surface px-2 py-0.5 text-[10.5px] font-medium text-muted">
              {activeVersion ? `Active v${activeVersion} stays unchanged` : "No active version yet"}
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
            The draft is compiled with the protected iAcquire policy and the employee&apos;s approved knowledge. A unique test session and memory scope keep the test out of production history and long-term memory. Nothing is written to the employee&apos;s saved configuration or chat.
          </p>
        </div>

        {loadingSummary ? (
          <div className="flex items-center gap-2 rounded-xl border border-line p-3 text-[13px] text-muted" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Comparing the draft with the active configuration…
          </div>
        ) : summaryError ? (
          <p className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft/40 p-3 text-[13px] text-danger-ink" role="alert">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {summaryError}
          </p>
        ) : summary ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-line p-3">
                <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">Draft version</p>
                <p className="mt-1 text-[16px] font-semibold">v{summary.version}</p>
                <p className="mt-0.5 text-[11.5px] text-muted">Would be the next version</p>
              </div>
              <div className="rounded-xl border border-line p-3">
                <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">Knowledge included</p>
                <p className="mt-1 text-[16px] font-semibold">{summary.knowledge.entries + summary.knowledge.documents}</p>
                <p className="mt-0.5 text-[11.5px] text-muted">
                  {summary.knowledge.entries} note{summary.knowledge.entries === 1 ? "" : "s"} · {summary.knowledge.documents} document{summary.knowledge.documents === 1 ? "" : "s"}
                </p>
              </div>
              <div className="rounded-xl border border-line p-3">
                <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">Provider</p>
                <p className="mt-1 text-[16px] font-semibold">{summary.connectionConfigured ? "Hermes Agent" : "Not connected"}</p>
                <p className="mt-0.5 text-[11.5px] text-muted">{summary.connectionConfigured ? "Real test available" : "Review only"}</p>
              </div>
            </div>

            <div>
              <p className="text-[12px] font-semibold">What changes from the active configuration</p>
              {summary.changed.length ? (
                <ul className="mt-1.5 space-y-1.5">
                  {summary.changed.map((change) => (
                    <li key={change.key} className="rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px]">
                      <span className="font-medium">{change.label}:</span>{" "}
                      <span className="text-muted">{change.before}</span> <span aria-hidden>→</span> <span className="text-ink-2">{change.after}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-[12.5px] text-muted">This draft matches the active configuration.</p>
              )}
            </div>

            {summary.warnings.length > 0 && (
              <ul className="space-y-1.5" aria-label="Test warnings">
                {summary.warnings.map((warning) => (
                  <li key={warning} className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft/40 p-3 text-[12.5px] text-warning-ink">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {warning}
                  </li>
                ))}
              </ul>
            )}
            {summary.riskFlags.length > 0 && (
              <p className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft/40 p-3 text-[12.5px] text-warning-ink">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> Risk review flags: {summary.riskFlags.join(", ")}. This draft was not applied.
              </p>
            )}
          </>
        ) : null}

        {unavailable && (
          <p className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft/40 p-3 text-[13px] text-warning-ink" role="status">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> {unavailable}
          </p>
        )}
        {stopped && (
          <p className="flex items-center gap-2 text-[12.5px] text-muted" role="status">
            <Check className="size-3.5 text-success" aria-hidden /> Test stopped. Nothing was saved.
          </p>
        )}

        <div ref={scrollRef} className="scrollbar-thin max-h-72 min-h-24 overflow-y-auto rounded-xl border border-line bg-surface p-3" aria-live="polite" aria-busy={running}>
          {messages.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-muted">Send a message to see how the draft behaves. The reply is produced by the real provider when one is connected.</p>
          ) : (
            <ol className="space-y-3">
              {messages.map((message) => (
                <li key={message.id} className={cn("text-[13px]", message.role === "user" ? "text-right" : "text-left")}>
                  <p className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted">{message.role === "user" ? "You" : agentName}</p>
                  {message.role === "assistant" ? (
                    <div className="inline-block max-w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-left">
                      <Markdown>{message.content}</Markdown>
                    </div>
                  ) : (
                    <p className="inline-block max-w-[85%] whitespace-pre-wrap rounded-xl bg-primary px-3 py-2 text-left text-white">{message.content}</p>
                  )}
                </li>
              ))}
              {running && (
                <li className="flex items-center gap-2 text-[12.5px] text-muted" role="status">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden /> {activity ?? "Working…"}
                </li>
              )}
            </ol>
          )}
        </div>
        {error && (
          <p className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft/40 p-3 text-[12.5px] text-danger-ink" role="alert">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
          </p>
        )}

        <div className="rounded-xl border border-line-strong p-2 focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10">
          <label htmlFor="preview-message" className="sr-only">
            Test message
          </label>
          <Textarea
            id="preview-message"
            rows={2}
            maxLength={4000}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!running) void send();
              }
            }}
            placeholder={summary?.connectionConfigured ? "Ask the draft employee something…" : "Connect the employee to run a live test."}
            className="border-0 bg-transparent focus:ring-0"
          />
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            <span className="text-[11px] text-muted">Enter to send · Shift+Enter for a new line</span>
            {running ? (
              <Button type="button" size="sm" variant="secondary" onClick={stop}>
                <Square className="size-3.5 fill-current" aria-hidden /> Stop test
              </Button>
            ) : (
              <Button type="button" size="sm" variant="brand" onClick={() => void send()} disabled={!input.trim() || !summary?.connectionConfigured}>
                <Send className="size-3.5" aria-hidden /> Run test
              </Button>
            )}
          </div>
        </div>
        <p className="text-[11.5px] leading-relaxed text-faint">
          A test does not prove that a production employee is online. Connection health is checked separately, and live use stays gated by the employee&apos;s verified provider permissions.
        </p>
      </div>
    </Dialog>
  );
}
