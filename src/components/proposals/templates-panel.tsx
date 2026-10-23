"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, EmptyState, Field, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { useCrmAction } from "@/components/crm/ui";
import { createTemplateAction } from "@/app/actions/proposals";
import { dayIn } from "@/lib/proposals/format";
import type { TemplateSummary } from "@/server/proposals/templates";

// Reusable wording and a starting set of price book items. The owner approves a version before anyone sends a proposal made from it.

const TONE = { draft: "warning", approved: "success", archived: "outline" } as const;

export function TemplatesPanel({ orgId, templates, canEdit, tz }: { orgId: string | null; templates: TemplateSummary[]; canEdit: boolean; tz: string }) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState("");
  async function create() {
    const r = await run("create", () => createTemplateAction(orgId, { name }), "Template started.");
    if (r) router.push(`/proposals/templates/${(r as { id: string }).id}`);
  }
  return (
    <div className="space-y-6">
      {templates.length === 0 ? (
        <EmptyState compact title="No templates yet" description="A template holds wording you reuse, such as an introduction, your terms, and a starting set of price book items. Nobody can start a proposal from one until the owner approves it." />
      ) : (
        <ul className="space-y-3" aria-label="Templates">
          {templates.map((t) => (
            <li key={t.id}>
              <Link href={`/proposals/templates/${t.id}`} className="block rounded-2xl border border-line bg-surface p-4 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-semibold text-ink">{t.name}</span>
                  <Badge tone={TONE[t.status]}>{t.status === "approved" ? "Approved" : t.status === "draft" ? "Not approved yet" : "Archived"}</Badge>
                </span>
                <span className="mt-1 block text-[12.5px] text-muted">
                  Latest version {t.currentVersion}
                  {t.approvedVersion !== null ? ` · approved version ${t.approvedVersion}${t.approvedVersion !== t.currentVersion ? " (a newer version is waiting for approval)" : ""}` : " · no version approved yet"}
                  {` · updated ${dayIn(t.updatedAt, tz)}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form className="max-w-md space-y-3 rounded-2xl border border-line bg-surface p-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }} aria-label="New template">
          <h2 className="text-[15px] font-semibold text-ink">New template</h2>
          <Field label="Name" htmlFor="tp-name" hint="For example: Website project, Monthly care plan."><Input id="tp-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className="text-[16px] sm:text-[14px]" /></Field>
          <Button type="submit" variant="secondary" loading={busy("create")} disabled={!name.trim()}>Start a template</Button>
        </form>
      ) : <p className="text-[12.5px] text-muted">The owner or a manager writes templates, and the owner approves them.</p>}
    </div>
  );
}
