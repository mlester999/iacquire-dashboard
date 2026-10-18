"use client";

import * as React from "react";
import Link from "next/link";
import { Activity, BookOpen, Brain, FlaskConical, Layers, Lock, ShieldCheck } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { CopyTextButton } from "@/components/ui/copy-button";
import { ConfigTestDialog } from "@/components/workforce/config-test-dialog";
import type { EmployeeInstructionOverview } from "@/server/workforce/instructions";
import type { AgentRoleKey } from "@/lib/agents";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";

const MANAGED_TONE = { iAcquire: "violet", "Your workspace": "primary", "The conversation": "neutral" } as const;

export function EmployeeInstructions({
  overview,
  agentName,
  role,
  timeZone,
  onOpenKnowledge,
}: {
  overview: EmployeeInstructionOverview;
  agentName: string;
  role: AgentRoleKey;
  timeZone: string;
  onOpenKnowledge: () => void;
}) {
  const [testing, setTesting] = React.useState(false);
  const settings = overview.active.settings;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Active configuration</p>
          <p className="mt-1 text-[22px] font-semibold tracking-tight">{overview.active.version ? `v${overview.active.version}` : "Not set"}</p>
          <p className="mt-0.5 text-[12px] text-muted">{overview.active.appliedAt ? `Applied ${relativeTime(overview.active.appliedAt)}` : "No applied version"}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Knowledge in the prompt</p>
          <p className="mt-1 text-[22px] font-semibold tracking-tight">{overview.knowledge.characters.toLocaleString()}</p>
          <p className="mt-0.5 text-[12px] text-muted">{overview.knowledge.truncated ? "Budget reached — some sources shortened" : "Characters, within the knowledge budget"}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Protected policy</p>
          <p className="mt-1 text-[22px] font-semibold tracking-tight">{overview.policyVersion}</p>
          <p className="mt-0.5 text-[12px] text-muted">Always sent last; never client-editable</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2"><Layers className="size-4" /> Instruction hierarchy</CardTitle>
            <CardDescription>What {agentName} receives, who controls it and what it can change. The protected policy always overrides the layers above it.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setTesting(true)} disabled={!settings}>
              <FlaskConical className="size-3.5" aria-hidden /> Test active configuration
            </Button>
            <Link href={`/workforce/${role.replaceAll("_", "-")}?tab=configure`} className="inline-flex min-h-9 items-center rounded-xl border border-line bg-surface px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2">
              Edit in Configure
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2.5">
            {overview.layers.map((layer, index) => (
              <li key={layer.key} className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2/40 p-3.5 sm:flex-row sm:items-start">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-[11px] font-semibold text-muted ring-1 ring-line">{String(index + 1).padStart(2, "0")}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13px] font-semibold">{layer.label}</p>
                    <Badge tone={MANAGED_TONE[layer.managedBy]}>{layer.managedBy}</Badge>
                    {!layer.editable && <Lock className="size-3 text-faint" aria-label="Read only" />}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{layer.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-primary-soft/40 p-3 text-[12px] leading-relaxed text-primary-ink">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Client instructions are quoted as business context beneath the protected policy. They cannot grant tools, bypass approval or reach another workspace.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2"><BookOpen className="size-4" /> SOUL.md and employee identity</CardTitle>
              <CardDescription>The profile identity file is owned by iAcquire&apos;s Hermes administrator. This workspace does not rewrite it.</CardDescription>
            </div>
            <CopyTextButton text={overview.soul} label="Copy SOUL.md" />
          </CardHeader>
          <CardContent className="space-y-3">
            <pre tabIndex={0} aria-label="SOUL.md content" className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{overview.soul}</pre>
            <div className="rounded-xl border border-line p-3">
              <p className="text-[12px] font-semibold">Editing model</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                The verified Hermes API has no endpoint that writes a profile&apos;s SOUL.md. The portal therefore does not pretend a workspace save changes it. Your editable layer is the versioned configuration above; it is sent on every run and can be tested before it is applied. Changing the underlying AI model or provider does not erase this employee&apos;s identity, conversations or knowledge.
              </p>
            </div>
            {overview.active.compiledInstructions && (
              <details className="rounded-xl border border-line">
                <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-medium">View the exact applied instructions</summary>
                <div className="border-t border-line p-3">
                  <pre tabIndex={0} aria-label="Applied employee instructions" className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted">{overview.active.compiledInstructions}</pre>
                  <div className="mt-2 flex justify-end"><CopyTextButton text={overview.active.compiledInstructions} label="Copy instructions" /></div>
                </div>
              </details>
            )}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2"><Brain className="size-4" /> Memory and retention</CardTitle>
                <CardDescription>What persists, and what can honestly be inspected.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-[12.5px]">
              <dl className="grid grid-cols-2 gap-3">
                <div><dt className="text-[11px] uppercase tracking-wide text-muted">Conversations</dt><dd className="mt-1 text-[16px] font-semibold">{overview.memory.conversations}</dd></div>
                <div><dt className="text-[11px] uppercase tracking-wide text-muted">Messages</dt><dd className="mt-1 text-[16px] font-semibold">{overview.memory.messages}</dd></div>
                <div><dt className="text-[11px] uppercase tracking-wide text-muted">Memory scope</dt><dd className="mt-1 break-all font-mono text-[11px]">{overview.memory.scopeLabel}</dd></div>
                <div><dt className="text-[11px] uppercase tracking-wide text-muted">Chat retention</dt><dd className="mt-1">{overview.memory.retentionDays ? `${overview.memory.retentionDays} days` : "Workspace default"}</dd></div>
              </dl>
              <p className="rounded-xl bg-surface-2 p-3 leading-relaxed text-muted">
                Each conversation has its own saved history. Long-term memory is kept by Hermes inside this employee&apos;s own profile and is scoped to this workspace and role, so two clients never share it.
              </p>
              <p className="rounded-xl border border-line p-3 leading-relaxed">
                <span className="font-medium">Inspection and editing: unavailable.</span> The verified Hermes API exposes no read or edit endpoint for profile memory, so this page does not offer a memory editor. It shows only recorded evidence.
              </p>
              {overview.memory.hermesMemoryEvidence.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-[12px] font-semibold">Recorded memory tool activity</p>
                  <ul className="space-y-1">
                    {overview.memory.hermesMemoryEvidence.map((item) => (
                      <li key={`${item.tool}-${item.at.toISOString()}`} className="flex items-center justify-between gap-2 text-[11.5px] text-muted">
                        <span>{item.label}</span><time dateTime={item.at.toISOString()}>{formatDateTime(item.at, timeZone)}</time>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : <p className="text-[11.5px] text-faint">No memory tool use has been recorded yet. That does not mean memory is absent; it means no completed call was recorded.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2"><Activity className="size-4" /> Usage and health</CardTitle>
                <CardDescription>Only recorded values. Unknown measurements stay unavailable.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-[12.5px]">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div><p className="text-[11px] uppercase tracking-wide text-muted">Runs</p><p className="mt-0.5 text-[16px] font-semibold">{overview.usage.runs}</p></div>
                <div><p className="text-[11px] uppercase tracking-wide text-muted">Completed</p><p className="mt-0.5 text-[16px] font-semibold">{overview.usage.completed}</p></div>
                <div><p className="text-[11px] uppercase tracking-wide text-muted">Failed</p><p className="mt-0.5 text-[16px] font-semibold">{overview.usage.failed}</p></div>
                <div><p className="text-[11px] uppercase tracking-wide text-muted">Tokens</p><p className="mt-0.5 text-[16px] font-semibold">{overview.usage.tokens.toLocaleString()}</p></div>
                <div><p className="text-[11px] uppercase tracking-wide text-muted">Tool steps</p><p className="mt-0.5 text-[16px] font-semibold">{overview.usage.toolCalls}</p></div>
                <div><p className="text-[11px] uppercase tracking-wide text-muted">Avg. latency</p><p className="mt-0.5 text-[16px] font-semibold">{overview.usage.averageLatencyMs !== null ? `${Math.round(overview.usage.averageLatencyMs / 1000)}s` : "—"}</p></div>
              </div>
              <p className="text-[11.5px] text-muted">
                {overview.usage.lastRunAt ? `Last run ${relativeTime(overview.usage.lastRunAt)}. ` : "No run recorded yet. "}
                Provider costs are not reported by Hermes, so no cost estimate is shown.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={onOpenKnowledge}><BookOpen className="size-3.5" aria-hidden /> Manage knowledge</Button>
                <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", overview.knowledge.truncated ? "border-warning/30 bg-warning-soft text-warning-ink" : "border-line bg-surface-2 text-muted")}>
                  {overview.knowledge.employeeNotes} employee notes · {overview.knowledge.companySections} company sections · {overview.knowledge.referenceDocuments} references
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {settings && (
        <ConfigTestDialog
          open={testing}
          onOpenChange={setTesting}
          role={role}
          agentName={agentName}
          draft={settings}
          activeVersion={overview.active.version}
        />
      )}
    </div>
  );
}
