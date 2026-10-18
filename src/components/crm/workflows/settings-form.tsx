"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Card, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { updateWorkflowSettingsAction } from "@/app/actions/crm-workflows";
import type { CrmScope } from "@/server/crm/page";
import type { FolderOption } from "@/components/crm/workflows/types";

export interface WorkflowSettingsValue {
  name: string;
  description: string | null;
  folderId: string | null;
  hourlyRunLimit: number;
}

/** Name, description, folder and the hourly safety limit. These apply right away; they aren't part of a version. */
export function WorkflowSettingsForm({ scope, workflowId, value, folders, readOnly }: { scope: CrmScope; workflowId: string; value: WorkflowSettingsValue; folders: FolderOption[]; readOnly: boolean }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState(value.name);
  const [description, setDescription] = React.useState(value.description ?? "");
  const [folderId, setFolderId] = React.useState(value.folderId ?? "");
  const [limit, setLimit] = React.useState(String(value.hourlyRunLimit));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const changed = name !== value.name || description !== (value.description ?? "") || folderId !== (value.folderId ?? "") || limit !== String(value.hourlyRunLimit);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "Give the workflow a name.";
    else if (name.trim().length > 80) e.name = "Keep the name under 80 characters.";
    if (description.length > 500) e.description = "Keep the description under 500 characters.";
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 10000) e.limit = "Choose a whole number from 1 to 10,000.";
    setErrors(e);
    if (Object.keys(e).length) return;
    await run("settings", () => updateWorkflowSettingsAction(scope.orgId, workflowId, { name: name.trim(), description: description.trim() || null, folderId: folderId || null, hourlyRunLimit: n }), "Settings saved.");
  };

  return (
    <Card className="max-w-2xl p-5">
      <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); void submit(); }}>
        <Field label="Name" htmlFor="wf-set-name" error={errors.name}>
          <Input id="wf-set-name" value={name} maxLength={80} disabled={readOnly} aria-invalid={!!errors.name} onChange={(ev) => setName(ev.target.value)} />
        </Field>
        <Field label="Description" htmlFor="wf-set-desc" optional error={errors.description} hint="What it's for, so teammates know when to change it.">
          <Textarea id="wf-set-desc" value={description} maxLength={500} rows={3} disabled={readOnly} aria-invalid={!!errors.description} onChange={(ev) => setDescription(ev.target.value)} />
        </Field>
        <Field label="Folder" htmlFor="wf-set-folder" optional>
          <Select id="wf-set-folder" value={folderId} disabled={readOnly} onChange={(ev) => setFolderId(ev.target.value)}>
            <option value="">No folder</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </Field>
        <Field
          label="Most runs per hour"
          htmlFor="wf-set-limit"
          error={errors.limit}
          hint="A safety limit against a runaway trigger, such as a bulk import. Past it, new runs aren't started that hour and the owner is told."
        >
          <Input id="wf-set-limit" type="number" inputMode="numeric" min={1} max={10000} step={1} value={limit} disabled={readOnly} aria-invalid={!!errors.limit} onChange={(ev) => setLimit(ev.target.value)} className="max-w-40" />
        </Field>
        {!readOnly && (
          <div className="flex justify-end">
            <Button type="submit" loading={busy("settings")} disabled={!changed}>Save settings</Button>
          </div>
        )}
      </form>
    </Card>
  );
}
