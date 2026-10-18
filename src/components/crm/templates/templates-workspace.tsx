"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, Copy, FileText, MoreHorizontal, Pencil, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input, Select } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Switch, Tabs } from "@/components/ui/overlays";
import { ConfirmDialog, PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { archiveTemplateAction, duplicateTemplateAction, restoreTemplateAction } from "@/app/actions/crm-templates";
import { cn, relativeTime } from "@/lib/utils";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import type { CrmScope } from "@/server/crm/page";
import type { TemplateView, WhatsappTemplateView } from "@/server/crm/message-templates";
import { CHANNEL_ICON, CHANNEL_ORDER, TemplateStatusBadge, TokenHighlight } from "@/components/crm/templates/parts";
import { TemplateEditor } from "@/components/crm/templates/template-editor";
import { CannedReplies } from "@/components/crm/templates/canned-replies";
import { WhatsappTemplates } from "@/components/crm/templates/whatsapp-templates";
import type { ChannelState, FolderOption, TestDestination } from "@/components/crm/templates/types";

type Tab = "templates" | "canned" | "whatsapp";

export interface TemplatesWorkspaceProps {
  scope: CrmScope;
  templates: TemplateView[];
  cannedReplies: TemplateView[];
  whatsappTemplates: WhatsappTemplateView[];
  folders: FolderOption[];
  channels: ChannelState[];
  destinations: TestDestination[];
  canManage: boolean;
  canApprove: boolean;
  canTestSend: boolean;
  canConfigure: boolean;
  initialTab: Tab;
}

/** Templates grouped by channel, then folder, with their status; canned replies; and the WhatsApp templates synced from Meta. */
export function TemplatesWorkspace(props: TemplatesWorkspaceProps) {
  const { scope, templates, cannedReplies, whatsappTemplates, folders, canManage } = props;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { run, busy } = useCrmAction();
  const [tab, setTab] = React.useState<Tab>(props.initialTab);
  const [q, setQ] = React.useState("");
  const [channel, setChannel] = React.useState<Channel | "">("");
  const [folder, setFolder] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  // The editor opens on a template id from the URL (?template=…, or "new"), so a link or a refresh lands on the same template.
  const open = params.get("template");
  const [archiving, setArchiving] = React.useState<TemplateView | null>(null);
  // A template just created or duplicated, until the refreshed list includes it, so the editor doesn't blink closed in between.
  const [fresh, setFresh] = React.useState<TemplateView | null>(null);

  const setOpen = (id: string | null) => {
    const sp = new URLSearchParams(params.toString());
    if (id) sp.set("template", id);
    else sp.delete("template");
    router.replace(`${pathname}${sp.toString() ? `?${sp}` : ""}`, { scroll: false });
  };
  const changeTab = (t: string) => {
    setTab(t as Tab);
    const sp = new URLSearchParams(params.toString());
    sp.delete("template");
    if (t === "templates") sp.delete("tab");
    else sp.set("tab", t);
    router.replace(`${pathname}${sp.toString() ? `?${sp}` : ""}`, { scroll: false });
  };

  const term = q.trim().toLowerCase();
  const shown = templates.filter(
    (t) =>
      (showArchived || t.status !== "archived") &&
      (!channel || t.channel === channel) &&
      (!folder || (folder === "none" ? !t.folderId : t.folderId === folder)) &&
      (!term || `${t.name} ${t.key} ${t.subject ?? ""} ${t.body} ${t.category ?? ""}`.toLowerCase().includes(term)),
  );
  const editing = open === "new" ? null : templates.find((t) => t.id === open) ?? (fresh?.id === open ? fresh : null);
  const editorOpen = open === "new" ? canManage : Boolean(editing);
  const counts = {
    templates: templates.filter((t) => t.status !== "archived").length,
    canned: cannedReplies.filter((t) => t.status !== "archived").length,
    whatsapp: whatsappTemplates.length,
  };

  return (
    <div>
      <PageTitle
        title="Message templates"
        description="Reusable messages for email, SMS and WhatsApp. Automations send only the exact version someone in your team approved; canned replies help your team answer faster in the inbox."
        actions={canManage && tab === "templates" ? <Button onClick={() => setOpen("new")}><Plus className="size-4" aria-hidden />New template</Button> : undefined}
      />
      {!canManage && <div className="mb-4"><ReadOnlyNotice>{scope.readOnly ? undefined : "You can read templates and use canned replies. Owners and managers write and approve them."}</ReadOnlyNotice></div>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search templates" placeholder="Search by name or wording" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {tab === "templates" && (
          <>
            <label className="sr-only" htmlFor="tpl-filter-channel">Channel</label>
            <Select id="tpl-filter-channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel | "")} className="w-auto min-w-36">
              <option value="">All channels</option>
              {CHANNEL_ORDER.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
            </Select>
            {folders.length > 0 && (
              <>
                <label className="sr-only" htmlFor="tpl-filter-folder">Folder</label>
                <Select id="tpl-filter-folder" value={folder} onChange={(e) => setFolder(e.target.value)} className="w-auto min-w-36">
                  <option value="">All folders</option>
                  <option value="none">No folder</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              </>
            )}
          </>
        )}
        {tab !== "whatsapp" && (
          <label className="ml-auto inline-flex min-h-11 items-center gap-2 text-[13px] text-ink-2 sm:min-h-9">
            <Switch checked={showArchived} onCheckedChange={setShowArchived} aria-label="Show archived" />
            Show archived
          </label>
        )}
      </div>

      <Tabs
        id="templates-tabs"
        value={tab}
        onValueChange={changeTab}
        items={[
          { value: "templates", label: "Templates", count: counts.templates },
          { value: "canned", label: "Canned replies", count: counts.canned },
          { value: "whatsapp", label: "WhatsApp (Meta)", count: counts.whatsapp },
        ]}
      >
        {tab === "templates" && (
          !shown.length ? (
            <Card>
              <EmptyState
                icon={<FileText className="size-5" />}
                title={templates.length ? "Nothing matches these filters" : "No templates yet"}
                description={templates.length ? "Try another channel or folder, or clear the search." : "Write the messages you send again and again, such as appointment reminders, quote follow-ups and thank-you notes. Approve one before automations use it."}
                action={canManage && !templates.length ? <Button variant="secondary" onClick={() => setOpen("new")}><Plus className="size-4" aria-hidden />Write a template</Button> : undefined}
              />
            </Card>
          ) : (
            <div className="space-y-6">
              {CHANNEL_ORDER.map((c) => {
                const inChannel = shown.filter((t) => t.channel === c);
                if (!inChannel.length) return null;
                const byFolder = new Map<string, TemplateView[]>();
                for (const t of inChannel) byFolder.set(t.folderName ?? "", [...(byFolder.get(t.folderName ?? "") ?? []), t]);
                const groups = [...byFolder.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
                const Icon = CHANNEL_ICON[c];
                return (
                  <section key={c} aria-labelledby={`tpl-ch-${c}`}>
                    <h3 id={`tpl-ch-${c}`} className="mb-2 flex items-center gap-2 text-[14px] font-semibold text-ink"><Icon className="size-4 text-muted" aria-hidden />{CHANNEL_LABELS[c]}<span className="text-[12.5px] font-normal text-muted">{inChannel.length}</span></h3>
                    <div className="space-y-3">
                      {groups.map(([f, items]) => (
                        <div key={f || "none"}>
                          {(groups.length > 1 || f) && <p className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-faint">{f || "No folder"}</p>}
                          <Card className="divide-y divide-line overflow-hidden p-0">
                            {items.map((t) => (
                              <div key={t.id} className={cn("flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50", t.status === "archived" && "opacity-70")}>
                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(t.id)}>
                                  <span className="flex flex-wrap items-center gap-2">
                                    <span className="text-[14px] font-medium text-ink">{t.name}</span>
                                    <TemplateStatusBadge status={t.status} approvedVersion={t.approvedVersion} />
                                    {t.purpose === "marketing" && <Badge tone="violet">Marketing</Badge>}
                                    {t.category && <Badge>{t.category}</Badge>}
                                  </span>
                                  {t.subject && <span className="mt-1 block truncate text-[12.5px] font-medium text-ink-2"><TokenHighlight text={t.subject} /></span>}
                                  <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-relaxed text-muted"><TokenHighlight text={t.body} /></span>
                                  <span className="mt-1 block text-[11.5px] text-faint" suppressHydrationWarning>
                                    v{t.currentVersion}{t.status === "draft" && t.currentVersion > 1 ? " · not approved" : ""} · updated {relativeTime(t.updatedAt)}{t.versionCreatedByName ? ` by ${t.versionCreatedByName}` : ""}
                                  </span>
                                </button>
                                {canManage && (
                                  <Menu>
                                    <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`}><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                                    <MenuContent>
                                      <MenuItem onSelect={() => setOpen(t.id)}><Pencil className="size-4" aria-hidden />Open</MenuItem>
                                      <MenuItem onSelect={async () => {
                                        const copy = await run("dup", () => duplicateTemplateAction(scope.orgId, t.id), "Copy created as a draft.");
                                        if (copy && typeof copy === "object") {
                                          setFresh(copy);
                                          setOpen(copy.id);
                                        }
                                      }}><Copy className="size-4" aria-hidden />Duplicate</MenuItem>
                                      <MenuSeparator />
                                      {t.status === "archived" ? (
                                        <MenuItem onSelect={() => void run("restore", () => restoreTemplateAction(scope.orgId, t.id), "Restored as a draft.")}><ArchiveRestore className="size-4" aria-hidden />Restore</MenuItem>
                                      ) : (
                                        <MenuItem destructive onSelect={() => setArchiving(t)}><Archive className="size-4" aria-hidden />Archive</MenuItem>
                                      )}
                                    </MenuContent>
                                  </Menu>
                                )}
                              </div>
                            ))}
                          </Card>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )
        )}
        {tab === "canned" && <CannedReplies scope={scope} replies={cannedReplies} folders={folders} canManage={canManage} q={q} showArchived={showArchived} />}
        {tab === "whatsapp" && <WhatsappTemplates items={whatsappTemplates} timeZone={scope.timezone} q={q} />}
      </Tabs>

      {editorOpen && (
        <TemplateEditor
          key={open ?? "new"}
          scope={scope}
          template={editing}
          defaultChannel={channel || "email"}
          folders={folders}
          whatsappTemplates={whatsappTemplates}
          channels={props.channels}
          destinations={props.destinations}
          canManage={canManage}
          canApprove={props.canApprove}
          canTestSend={props.canTestSend}
          canConfigure={props.canConfigure}
          onClose={() => setOpen(null)}
          onOpenOther={(t) => {
            setFresh(t);
            setOpen(t.id);
          }}
        />
      )}
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Archive "${archiving?.name ?? ""}"?`}
        description={archiving?.status === "approved" ? "Its approval is withdrawn: automations that use it stop sending it. You can restore it later as a draft." : "It's hidden from the list and never sent. You can restore it later."}
        confirmLabel="Archive"
        danger
        loading={busy("archive")}
        onConfirm={async () => {
          if (archiving && (await run("archive", () => archiveTemplateAction(scope.orgId, archiving.id), "Template archived."))) setArchiving(null);
        }}
      />
    </div>
  );
}
