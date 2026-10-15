"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { Section, SiteContent } from "@/lib/website/doc";
import { sectionFromJson } from "@/lib/website/editor/paste";
import { findNode, getElement, getSection } from "@/lib/website/ops";
import { AreaControl, Group } from "./controls";
import { useServices } from "./context";

/**
 * Agency designers only. Shows an item's id and lets them copy its structure as JSON, or replace a section from JSON copied elsewhere (another
 * site or a template). Pasted JSON goes through exactly the same validation as everything else, may not point at another client's pictures, and
 * gets fresh ids. Nothing here accepts HTML, CSS or script, because the document model has no place to put them.
 */
export function AdvancedGroup({ doc, id, onReplaceSection }: { doc: SiteContent; id: string; onReplaceSection: (section: Section) => void }) {
  const { assets } = useServices();
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const node = findNode(doc, id);
  const section = node?.kind === "section" ? getSection(doc, id) : null;
  const element = node?.kind === "element" ? getElement(doc, id) : null;
  const target = section ?? element;
  if (!target) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(target, null, 2));
      toast.success("Copied. Paste it into another section's Advanced box, here or in another website.");
    } catch {
      toast.error("Your browser wouldn't let us copy. Select the text and copy it yourself.");
    }
  };
  const replace = () => {
    const r = sectionFromJson(doc, text, new Set(assets.map((a) => a.id.toLowerCase())));
    if (!r.ok) return setError(r.error);
    setError(null);
    onReplaceSection(r.section);
    setText("");
    toast.success("Section replaced. Undo brings the old one back.");
  };
  return (
    <Group title="Advanced (agency)" defaultOpen={false}>
      <p className="text-[11.5px] leading-relaxed text-muted">Id <code className="rounded bg-surface-3 px-1">{id}</code>. For moving structure between sites and templates.</p>
      <Button size="sm" variant="secondary" onClick={() => void copy()}>Copy as JSON</Button>
      {section && (
        <div className="space-y-1.5">
          <AreaControl aria-label="Section JSON to paste" rows={5} value={text} placeholder="Paste a section copied with “Copy as JSON”" onChange={(e) => { setText(e.target.value); setError(null); }} />
          {error && <p role="alert" className="text-[11.5px] text-danger-ink">{error}</p>}
          <Button size="sm" variant="soft" disabled={!text.trim()} onClick={replace}>Replace this section</Button>
        </div>
      )}
    </Group>
  );
}
