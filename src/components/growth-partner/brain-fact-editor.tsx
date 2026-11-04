"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import type { BUSINESS_BRAIN_SECTIONS, BusinessBrainFact } from "@/lib/ai-growth-partner";
import { saveGrowthPartnerBusinessBrainFactAction } from "@/app/actions/ai-growth-partner";

type BrainSection = (typeof BUSINESS_BRAIN_SECTIONS)[number];

function editableValue(fact: BusinessBrainFact) {
  if (fact.value === null || fact.value === undefined) return "";
  if (Array.isArray(fact.value)) return fact.value.map((item) => String(item)).join("\n");
  if (typeof fact.value === "object") return JSON.stringify(fact.value, null, 2);
  return String(fact.value);
}

function hintFor(fact: BusinessBrainFact) {
  if (Array.isArray(fact.value)) return "Use one item per line.";
  if (typeof fact.value === "object" && fact.value !== null) return "Keep the existing structured format when editing these details.";
  return "Leave this blank to mark the detail as unknown.";
}

export function BrainFactEditor({
  section,
  factKey,
  fact,
  baseVersion,
}: {
  section: BrainSection;
  factKey: string;
  fact: BusinessBrainFact;
  baseVersion: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(() => editableValue(fact));
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await saveGrowthPartnerBusinessBrainFactAction({ baseVersion, section, key: factKey, valueText: value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError("This detail could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <Button type="button" variant="ghost" size="sm" className="mt-2 !h-9 px-2 text-[13px]" onClick={() => { setValue(editableValue(fact)); setEditing(true); }}>
        Edit detail
      </Button>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-primary/20 bg-surface-2/50 p-3">
      <label htmlFor={`brain-${section}-${factKey}`} className="block text-[12px] font-medium text-ink-2">Update this business detail</label>
      <Textarea
        id={`brain-${section}-${factKey}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={16_000}
        rows={Array.isArray(fact.value) || (typeof fact.value === "object" && fact.value !== null) ? 5 : 3}
        aria-describedby={`brain-${section}-${factKey}-hint`}
      />
      <p id={`brain-${section}-${factKey}-hint`} className="text-[12px] text-muted">{hintFor(fact)} Saving creates a new draft version for review.</p>
      {error && <p role="alert" className="text-[13px] text-danger-ink">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" loading={saving} onClick={() => void save()}>Save as draft</Button>
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>
      </div>
    </div>
  );
}
