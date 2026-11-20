"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/primitives";
import {
  browseWorkspaceKnowledgeAction, previewWorkspaceKnowledgeAction, reviewWorkspaceKnowledgeAction, syncWorkspaceKnowledgeAction,
} from "@/app/actions/workspace-oauth";
import type {
  AirtableKnowledgeTable, NotionKnowledgeChoice, WorkspaceKnowledgeChoice, WorkspaceKnowledgeSelection, WorkspaceKnowledgeView,
} from "@/lib/integrations/workspace-knowledge";
import { WORKSPACE_OAUTH_LABEL, type WorkspaceConnectionView } from "@/lib/integrations/workspace-oauth";

type Choice = AirtableKnowledgeTable | NotionKnowledgeChoice | WorkspaceKnowledgeChoice;
type Preview = { snapshotId: string; title: string; content: string; capturedFrom: number; flagged: boolean };
const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function WorkspaceKnowledgeControls({ orgId, connection, saved }: {
  orgId: string;
  connection: WorkspaceConnectionView;
  saved: WorkspaceKnowledgeView | undefined;
}) {
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [notion, setNotion] = useState<NotionKnowledgeChoice[]>([]);
  const [bases, setBases] = useState<WorkspaceKnowledgeChoice[]>([]);
  const [tables, setTables] = useState<AirtableKnowledgeTable[]>([]);
  const [base, setBase] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [fields, setFields] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasBrowsed, setHasBrowsed] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const id = useId();
  const provider = connection.provider;
  const name = WORKSPACE_OAUTH_LABEL[provider];
  const authorized = connection.configured && connection.status !== "disconnected" && connection.status !== "needs_reauth";
  const notionChoice = notion.find((choice) => choice.id === selectedId);
  const table = tables.find((choice) => choice.id === selectedId);
  let selection: WorkspaceKnowledgeSelection | undefined;
  if (notionChoice) selection = { kind: notionChoice.kind, id: notionChoice.id };
  if (base && table && fields.length) selection = { kind: "table", baseId: base, tableId: table.id, fieldIds: fields };

  function run(operation: () => Promise<void>) {
    setError("");
    setNotice("");
    startTransition(operation);
  }

  function mergeChoices<T extends Choice>(existing: T[], choices: T[]) {
    return [...new Map([...existing, ...choices].map((choice) => [choice.id, choice])).values()];
  }

  function browse(nextCursor?: string, baseId?: string) {
    run(async () => {
      const result = await browseWorkspaceKnowledgeAction(orgId, provider, { query, cursor: nextCursor, baseId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const data = result.data;
      setHasBrowsed(true);
      if (data.kind !== "tables") setCursor(data.cursor);
      if (!nextCursor) {
        setSelectedId("");
        setFields([]);
      }
      if (data.kind === "notion") setNotion((previous) => mergeChoices(nextCursor ? previous : [], data.choices));
      if (data.kind === "bases") {
        setBases((previous) => mergeChoices(nextCursor ? previous : [], data.choices));
        if (!nextCursor) {
          setBase("");
          setTables([]);
        }
      }
      if (data.kind === "tables") setTables(data.choices);
    });
  }

  function sync(nextSelection?: WorkspaceKnowledgeSelection) {
    setPreview(null);
    run(async () => {
      const result = await syncWorkspaceKnowledgeAction(orgId, provider, nextSelection);
      if (!result.ok) setError(result.error);
      else if (result.data?.latest?.status === "pending") setNotice("Snapshot ready for review.");
      else if (result.data?.status === "unavailable") setNotice(result.data.message ?? "This source has no supported content.");
      else setNotice("Sync finished.");
    });
  }

  function showPreview(snapshotId: string) {
    run(async () => {
      const result = await previewWorkspaceKnowledgeAction(orgId, provider, snapshotId);
      if (!result.ok) setError(result.error);
      else setPreview({ snapshotId, ...result.data });
    });
  }

  function review(snapshotId: string, decision: "approved" | "rejected") {
    run(async () => {
      const result = await reviewWorkspaceKnowledgeAction(orgId, provider, snapshotId, decision);
      if (!result.ok) setError(result.error);
      else {
        setPreview(null);
        setNotice(decision === "approved" ? "Approved for internal Growth Partner conversations." : "Snapshot rejected.");
      }
    });
  }

  if (!authorized && !saved) return null;
  return (
    <details className="group min-w-0 rounded-xl border border-line bg-surface-2/50">
      <summary className="cursor-pointer rounded-xl px-3 py-3 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-primary">
        {name} knowledge import
      </summary>
      <div className="space-y-4 px-3 pb-4 text-sm">
        <p className="text-muted">Choose one shared source. Review each new snapshot before your Growth Partner can use it as an internal reference.</p>
        {saved && (
          <div className="space-y-2 rounded-lg border border-line bg-surface p-3">
            <p className="break-words font-semibold text-ink">{saved.title}</p>
            <p className="text-muted">
              {saved.syncedAt ? "Last successful sync " + dateFormat.format(new Date(saved.syncedAt)) + " UTC." : "Awaiting first successful sync."}
              {" "}{saved.activeReference ? "An approved reference is active." : "No active reference."}
            </p>
            {saved.message && <p className="text-muted">{saved.message}</p>}
            {saved.retryAfter && <p className="text-muted">Retry after {dateFormat.format(new Date(saved.retryAfter))} UTC.</p>}
            {saved.latest?.status === "pending" && <p className="font-medium text-ink">Pending review</p>}
            {saved.latest?.status === "rejected" && <p className="font-medium text-ink">Latest snapshot rejected</p>}
            {authorized && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => sync()}>Sync now</Button>
                {saved.status !== "unavailable" && saved.latest && saved.latest.status !== "superseded" && (
                  <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => showPreview(saved.latest!.id)}>
                    Review snapshot
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        {preview && preview.snapshotId === saved?.latest?.id && saved.status !== "unavailable" && (
          <div className="space-y-2 rounded-lg border border-line bg-surface p-3">
            <p className="break-words font-semibold text-ink">{preview.title}</p>
            <p className="text-muted">{preview.capturedFrom} source {preview.capturedFrom === 1 ? "record" : "records"}</p>
            <pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-primary" aria-label="Imported reference text">{preview.content}</pre>
            {preview.flagged && <p className="text-muted">Potentially unsafe instructions were detected. Edit the source and sync it again to approve a clean snapshot.</p>}
            {saved.latest.status === "pending" && <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={pending || preview.flagged || saved.status !== "current"} onClick={() => review(preview.snapshotId, "approved")}>Approve reference</Button>
              <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => review(preview.snapshotId, "rejected")}>Reject snapshot</Button>
            </div>}
          </div>
        )}
        {authorized && (
          <div className="space-y-3">
            {provider === "notion" ? (
              <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); browse(); }}>
                <Label htmlFor={id + "-query"}>Search shared pages and data sources</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input className="min-w-0 flex-1" id={id + "-query"} type="search" value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} />
                  <Button type="submit" size="sm" variant="secondary" disabled={pending}>Find sources</Button>
                </div>
              </form>
            ) : (
              <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => browse()}>Find shared bases</Button>
            )}
            {notion.length > 0 && <div className="space-y-1">
              <Label htmlFor={id + "-page"}>Notion source</Label>
              <Select id={id + "-page"} value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={pending}>
                <option value="">Select a shared source</option>
                {notion.map((choice) => <option value={choice.id} key={choice.id}>{choice.title} ({choice.kind === "page" ? "page" : "data source"})</option>)}
              </Select>
            </div>}
            {bases.length > 0 && <div className="space-y-1">
              <Label htmlFor={id + "-base"}>Airtable base</Label>
              <Select id={id + "-base"} value={base} disabled={pending} onChange={(event) => {
                setBase(event.target.value);
                setTables([]);
                setFields([]);
                setSelectedId("");
                if (event.target.value) browse(undefined, event.target.value);
              }}>
                <option value="">Select a shared base</option>
                {bases.map((choice) => <option value={choice.id} key={choice.id}>{choice.title}</option>)}
              </Select>
            </div>}
            {tables.length > 0 && <div className="space-y-1">
              <Label htmlFor={id + "-table"}>Airtable table</Label>
              <Select id={id + "-table"} value={selectedId} disabled={pending} onChange={(event) => { setSelectedId(event.target.value); setFields([]); }}>
                <option value="">Select a table</option>
                {tables.map((choice) => <option value={choice.id} key={choice.id}>{choice.title}</option>)}
              </Select>
            </div>}
            {table && (table.fields.length === 0 ? <p className="text-muted">No supported fields in this table.</p> : (
              <fieldset className="max-h-52 space-y-1 overflow-auto rounded-lg border border-line p-2" disabled={pending}>
                <legend className="px-1 font-medium text-ink">Fields to import (up to 8)</legend>
                {table.fields.map((field) => (
                  <label key={field.id} className="flex min-h-9 cursor-pointer items-center gap-2 break-words px-1 text-ink">
                    <input type="checkbox" className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-primary"
                      checked={fields.includes(field.id)} disabled={!fields.includes(field.id) && fields.length >= 8}
                      onChange={(event) => setFields(event.target.checked ? [...fields, field.id] : fields.filter((entry) => entry !== field.id))} />
                    <span className="min-w-0">{field.title}</span>
                  </label>
                ))}
              </fieldset>
            ))}
            {hasBrowsed && notion.length === 0 && bases.length === 0 && !cursor && <p className="text-muted">No shared sources found. Check the permissions in {name}.</p>}
            {hasBrowsed && base && tables.length === 0 && !pending && !error && <p className="text-muted">No readable tables in this base.</p>}
            {cursor && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => browse(cursor)}>Load more sources</Button>}
            {selection && <Button type="button" size="sm" disabled={pending} onClick={() => sync(selection)}>Import for review</Button>}
          </div>
        )}
        {pending && <p role="status" className="text-muted">Working…</p>}
        {notice && <p role="status" className="text-ink">{notice}</p>}
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </details>
  );
}
