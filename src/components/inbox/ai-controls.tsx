"use client";

import * as React from "react";
import { Bot, Hand, PauseCircle, PlayCircle, Send, Sparkles, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { assignAiEmployeeAction, pauseAiAction, resumeAiAction, takeOverAction, transferConversationAction } from "@/app/actions/inbox";
import { employeeShortName } from "@/components/inbox/inbox-list-panel";
import { sentenceCase } from "@/lib/utils";
import type { ConversationListItem } from "@/server/messaging/inbox-list";
import type { ConversationAiEmployee } from "@/server/messaging/inbox-context";

type Run = (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) => Promise<boolean>;

export interface AiControlsProps {
  c: Pick<ConversationListItem, "id" | "ownerKind" | "ownerName" | "ownerUserId" | "aiAgent" | "aiPaused">;
  me: { id: string; isOwner: boolean };
  perms: { reply: boolean; assign: boolean; resume: boolean };
  team: Array<{ id: string; name: string; role: string }>;
  aiEmployees: ConversationAiEmployee[];
  busy: string | null;
  run: Run;
}

/**
 * Who is speaking for this conversation, and the controls over it: take over, pause the AI, hand it back, choose which AI employee, hand it to a
 * teammate. Every control is also checked on the server; hiding one here is a convenience, not the rule.
 */
export function AiControls({ c, me, perms, team, aiEmployees, busy, run }: AiControlsProps) {
  const mine = c.ownerKind === "human" && c.ownerUserId === me.id;
  const employee = c.aiAgent ? employeeShortName(c.aiAgent) : null;
  const [reason, setReason] = React.useState("");
  const [pauseOpen, setPauseOpen] = React.useState(false);
  const [handTo, setHandTo] = React.useState("");
  const [handOpen, setHandOpen] = React.useState(false);

  const status =
    c.ownerKind === "ai" && c.aiPaused ? (
      <>
        <PauseCircle className="size-4 text-warning-ink" aria-hidden />
        <span><strong>AI replies are paused.</strong><span className="hidden sm:inline"> {employee ?? "The AI employee"} stays on this conversation but will not reply until you resume.</span></span>
      </>
    ) : c.ownerKind === "ai" ? (
      <>
        <Bot className="size-4 text-violet-ink" aria-hidden />
        <span><strong>{employee ?? "The AI"} is handling this.</strong><span className="hidden sm:inline"> It follows your rules and hands off when a person is needed.</span></span>
      </>
    ) : c.ownerKind === "human" ? (
      <>
        <UserRound className="size-4 text-primary" aria-hidden />
        <span><strong>{mine ? "You are" : `${c.ownerName ?? "A teammate"} is`} handling this.</strong><span className="hidden sm:inline"> {employee ? `${employee} is attached but will not reply.` : "The AI will not reply."}</span></span>
      </>
    ) : (
      <>
        <Hand className="size-4 text-muted" aria-hidden />
        <span><strong>Nobody owns this yet.</strong><span className="hidden sm:inline"> The AI will not reply.</span></span>
      </>
    );

  return (
    <div className="space-y-1.5 border-b border-line bg-surface-2/60 px-3 py-2 text-[13px] sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-start gap-2">{status}</span>
        <span className="flex max-w-full gap-2 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible sm:pb-0 [&>*]:shrink-0">
          {c.ownerKind !== "human" && perms.reply && (
            <Button size="sm" variant="secondary" loading={busy === "takeover"} onClick={() => run("takeover", () => takeOverAction(c.id), "You're handling this now.")}>Take over</Button>
          )}
          {c.ownerKind === "ai" && !c.aiPaused && perms.reply && (
            <Popover open={pauseOpen} onOpenChange={setPauseOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="secondary"><PauseCircle className="size-3.5" aria-hidden />Pause AI</Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(320px,calc(100vw-32px))] p-3">
                <p className="text-[13px] text-muted">The AI stops replying here, but stays on the conversation. Drafts waiting for approval are kept.</p>
                <label className="sr-only" htmlFor="pause-reason">Why (optional)</label>
                <Input id="pause-reason" className="mt-2" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Why? (optional, visible to your team)" />
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setPauseOpen(false)}>Cancel</Button>
                  <Button size="sm" variant="brand" loading={busy === "pause"} onClick={async () => { if (await run("pause", () => pauseAiAction(c.id, reason), "AI replies are paused.")) { setPauseOpen(false); setReason(""); } }}>Pause AI</Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
          {((c.ownerKind === "ai" && c.aiPaused) || c.ownerKind !== "ai") && perms.resume && (c.ownerKind === "ai" || mine || perms.assign) && (c.aiAgent || c.ownerKind === "ai") && (
            <Button size="sm" variant="soft" loading={busy === "resume"} onClick={() => run("resume", () => resumeAiAction(c.id), c.ownerKind === "ai" ? "AI replies are back on." : "Handed back to the AI.")}>
              {c.ownerKind === "ai" ? <PlayCircle className="size-3.5" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
              {c.ownerKind === "ai" ? "Resume AI" : "Hand back to AI"}
            </Button>
          )}
          {perms.reply && (c.ownerKind !== "human" || mine || perms.assign) && team.length > 0 && (
            <Popover open={handOpen} onOpenChange={setHandOpen}>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost"><Send className="size-3.5" aria-hidden />Hand to…</Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(320px,calc(100vw-32px))] p-3">
                <p className="text-[13px] text-muted">They become the owner and are told. The AI stops replying while they own it.</p>
                <label className="sr-only" htmlFor="hand-to">Hand to</label>
                <Select id="hand-to" className="mt-2" value={handTo} onChange={(e) => setHandTo(e.target.value)}>
                  <option value="">Choose a teammate…</option>
                  {team.filter((t) => t.id !== c.ownerUserId).map((t) => <option key={t.id} value={t.id}>{t.name} · {sentenceCase(t.role)}</option>)}
                </Select>
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setHandOpen(false)}>Cancel</Button>
                  <Button size="sm" variant="brand" disabled={!handTo} loading={busy === "transfer"} onClick={async () => { if (await run("transfer", () => transferConversationAction(c.id, handTo), "Handed over.")) { setHandOpen(false); setHandTo(""); } }}>Hand over</Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </span>
      </div>
      {perms.assign && aiEmployees.length > 0 && (
        <div className="hidden items-center gap-2 sm:flex">
          <label htmlFor="ai-employee" className="shrink-0 text-muted">AI employee</label>
          <div className="w-full max-w-[260px]">
            <Select id="ai-employee" className="h-9 sm:h-8 text-[14px]" value={c.aiAgent?.id ?? ""} disabled={busy === "ai-employee"} onChange={(e) => { const v = e.target.value; if (v) void run("ai-employee", () => assignAiEmployeeAction(c.id, v), "AI employee updated."); }}>
              {!c.aiAgent && <option value="">None chosen</option>}
              {aiEmployees.map((a) => <option key={a.id} value={a.id}>{a.name}{a.ready ? "" : ` (${a.problem?.toLowerCase() ?? "not ready"})`}</option>)}
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}
