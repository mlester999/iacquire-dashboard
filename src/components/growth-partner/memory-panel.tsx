"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Brain, Pencil, Plus, Trash2 } from "lucide-react";
import {
  deleteGrowthPartnerMemoryAction,
  saveGrowthPartnerMemoryAction,
  updateGrowthPartnerMemoryAction,
} from "@/app/actions/ai-growth-partner";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { Select, Textarea } from "@/components/ui/primitives";
import { GROWTH_PARTNER_MEMORY_KINDS, type GrowthPartnerMemoryKind } from "@/lib/ai-growth-partner-memory";
import type { GrowthPartnerMemory } from "@/lib/ai-growth-partner-memory";

const kindLabels: Record<GrowthPartnerMemoryKind, string> = {
  preference: "Preference",
  decision: "Decision",
  goal: "Goal",
  working_context: "Working context",
};

function showTime(value: Date, timezone: string) {
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: timezone }).format(value);
  } catch {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(value);
  }
}

export function GrowthPartnerMemoryPanel({
  memories,
  canManage,
  hasPartner,
  timezone,
}: {
  memories: GrowthPartnerMemory[];
  canManage: boolean;
  hasPartner: boolean;
  timezone: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<string | "new" | null>(null);
  const [kind, setKind] = React.useState<GrowthPartnerMemoryKind>("working_context");
  const [content, setContent] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  function beginNew() {
    setEditing("new");
    setKind("working_context");
    setContent("");
    setError(null);
    setNotice(null);
  }

  function beginEdit(memory: GrowthPartnerMemory) {
    setEditing(memory.id);
    setKind(memory.kind);
    setContent(memory.content);
    setError(null);
    setNotice(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = editing === "new"
        ? await saveGrowthPartnerMemoryAction({ kind, content })
        : await updateGrowthPartnerMemoryAction({
            memoryId: editing!,
            baseRevision: memories.find((item) => item.id === editing)?.revision ?? 0,
            kind,
            content,
          });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(null);
      setNotice(editing === "new" && result.data && "duplicate" in result.data && result.data.duplicate
        ? "That note is already saved."
        : "Workspace memory saved.");
      router.refresh();
    } catch {
      setError("Workspace memory could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(memory: GrowthPartnerMemory) {
    if (!window.confirm("Remove this note from the AI Growth Partner's saved workspace memory? Its original conversation message will remain.")) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteGrowthPartnerMemoryAction({ memoryId: memory.id, baseRevision: memory.revision });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Note removed from workspace memory.");
      router.refresh();
    } catch {
      setError("Workspace memory could not be removed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border border-line bg-surface shadow-soft">
      <CardHeader className="items-center">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-violet-ink"><Brain className="size-5" aria-hidden /></div>
          <div className="min-w-0">
            <CardTitle>Partner memory</CardTitle>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">Shared, persistent workspace notes used as context by the AI Growth Partner.</p>
          </div>
        </div>
        <Badge tone="violet">App memory</Badge>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <p className="rounded-xl border border-line bg-surface-2/55 px-3.5 py-3 text-[13px] leading-relaxed text-muted">
          This memory is saved in the workspace database, is separate from Hermes runtime memory, and cannot change permissions or approval rules.
          {canManage ? " Owners and admins can add, correct or remove notes here or in the permanent conversation." : " Only workspace owners and admins can change shared memory."}
        </p>
        {!hasPartner && <p className="text-[13px] text-muted">Set up the AI Growth Partner identity before saving workspace memory.</p>}
        {error && <p role="alert" className="text-[13px] text-danger-ink">{error}</p>}
        {notice && <p role="status" className="text-[13px] text-success-ink">{notice}</p>}
        {editing !== null && (
          <div className="space-y-3 rounded-xl border border-primary/20 bg-surface-2/45 p-3.5">
            <label className="block space-y-1.5 text-[13px] font-medium text-ink-2">
              Note type
              <Select value={kind} onChange={(event) => setKind(event.target.value as GrowthPartnerMemoryKind)}>
                {GROWTH_PARTNER_MEMORY_KINDS.map((value) => <option key={value} value={value}>{kindLabels[value]}</option>)}
              </Select>
            </label>
            <label className="block space-y-1.5 text-[13px] font-medium text-ink-2">
              Saved note
              <Textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={1_000} rows={3} />
            </label>
            <p className="text-[12px] text-muted">Up to 1,000 characters. Contact details, credentials and instruction-like text are not saved. Notes are treated as context, not commands.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" loading={busy} disabled={!hasPartner} onClick={() => void save()}>Save note</Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing(null); setError(null); }}>Cancel</Button>
            </div>
          </div>
        )}
        {memories.length ? (
          <ul className="space-y-2">
            {memories.map((memory) => (
              <li key={memory.id} className="rounded-xl border border-line bg-surface px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{kindLabels[memory.kind]}</Badge>
                  <span className="text-[12px] text-faint">v{memory.revision} · updated {showTime(memory.updatedAt, timezone)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{memory.content}</p>
                {canManage && editing === null && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => beginEdit(memory)}><Pencil className="size-3.5" aria-hidden /> Correct</Button>
                    <Button type="button" variant="ghost" size="sm" className="text-danger-ink" disabled={busy} onClick={() => void remove(memory)}><Trash2 className="size-3.5" aria-hidden /> Remove</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-[13px] text-muted">No workspace memory has been saved yet.</p>}
        {canManage && editing === null && (
          <Button type="button" variant="secondary" size="sm" disabled={!hasPartner || busy} onClick={beginNew}>
            <Plus className="size-4" aria-hidden /> Add a note
          </Button>
        )}
        <p className="border-t border-line pt-3 text-[12px] leading-relaxed text-muted">
          In the permanent conversation, use <span className="font-medium text-ink-2">Remember: [one note]</span> or <span className="font-medium text-ink-2">Forget: [the full saved note]</span>. Chat history and Hermes memory have separate retention.
        </p>
      </CardContent>
    </Card>
  );
}
