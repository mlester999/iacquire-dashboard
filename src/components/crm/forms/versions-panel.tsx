"use client";

import * as React from "react";
import { Eye, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { getFormVersionPreviewAction, restoreFormVersionAction } from "@/app/actions/crm-forms";
import { PublicForm } from "@/components/crm/forms/public-form";
import { formatDateTime } from "@/lib/utils";
import type { PublicFormDef } from "@/lib/crm/forms/spec";
import type { CrmScope } from "@/server/crm/page";
import type { FormVersionView } from "@/components/crm/forms/types";

/** Every published version, frozen: what visitors saw, who published it and when. An older one can be put back into the draft. */
export function VersionsPanel({ scope, formId, versions, canManage, draftRevision, dirty, onRestored }: {
  scope: CrmScope;
  formId: string;
  versions: FormVersionView[];
  canManage: boolean;
  draftRevision: number;
  dirty: boolean;
  onRestored: (revision: number) => void;
}) {
  const { run, busy } = useCrmAction();
  const [preview, setPreview] = React.useState<{ version: number; def: PublicFormDef } | null>(null);
  const [restoring, setRestoring] = React.useState<FormVersionView | null>(null);
  if (!versions.length) {
    return <Card><EmptyState compact icon={<History className="size-5" aria-hidden />} title="Not published yet" description="Each time you publish, the form is frozen as a new version. Submissions always keep the version they answered." /></Card>;
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {versions.map((v) => (
          <li key={v.id}>
            <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium text-ink">Version {v.version}{v.current && <Badge tone="success">Live</Badge>}</p>
                <p className="mt-0.5 text-[12px] text-muted">Published {formatDateTime(v.publishedAt, scope.timezone)}{v.publishedByName ? ` by ${v.publishedByName}` : ""} · {v.questionCount} {v.questionCount === 1 ? "question" : "questions"}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" loading={busy(`p-${v.id}`)} onClick={() => void run(`p-${v.id}`, () => getFormVersionPreviewAction(scope.orgId, formId, v.id)).then((def) => { if (def && typeof def === "object") setPreview({ version: v.version, def }); })}>
                  <Eye className="size-3.5" aria-hidden />Preview
                </Button>
                {canManage && !v.current && <Button size="sm" variant="secondary" onClick={() => setRestoring(v)}><RotateCcw className="size-3.5" aria-hidden />Use in draft</Button>}
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <Dialog open={Boolean(preview)} onOpenChange={(o) => !o && setPreview(null)} size="lg" title={preview ? `Version ${preview.version}` : ""} description="Exactly as visitors saw it. Sending is switched off in this preview.">
        {preview && (
          <div>
            <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-ink">{preview.def.title}</h2>
            {preview.def.intro && <p className="mt-1.5 whitespace-pre-line text-[14px] text-muted">{preview.def.intro}</p>}
            <div className="mt-5"><PublicForm def={preview.def} action={null} idPrefix={`pv${preview.version}`} /></div>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={Boolean(restoring)}
        onOpenChange={(o) => !o && setRestoring(null)}
        title={restoring ? `Use version ${restoring.version} in the draft?` : ""}
        description={dirty ? "Your unsaved changes will be lost. The draft gets this version's questions, consent and actions; publish to make it live again as a new version." : "The draft gets this version's questions, consent and actions. Nothing changes for visitors until you publish, which makes a new version."}
        confirmLabel="Use in draft"
        loading={busy("restore")}
        onConfirm={() => restoring && void run("restore", () => restoreFormVersionAction(scope.orgId, formId, restoring.id, draftRevision), "The draft now matches that version.").then((r) => {
          if (r && typeof r === "object") {
            setRestoring(null);
            onRestored(r.revision);
          }
        })}
      />
    </div>
  );
}
