"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileImage, FileText, Lock, Paperclip, Upload } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/overlays";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { cn, formatBytes } from "@/lib/utils";

interface Attachment { id:string; filename:string; size_bytes:number; visibility:"client"|"internal" }
const isImage = (name: string) => /\.(png|jpe?g)$/i.test(name);
export function SupportAttachments({ticketId,attachments,audience,closed}:{ticketId:string;attachments:Attachment[];audience:"client"|"agency";closed:boolean}) {
  const router=useRouter();const [pending,setPending]=React.useState(false);const [error,setError]=React.useState<string|null>(null);
  const [file,setFile]=React.useState<File|null>(null);const [internal,setInternal]=React.useState(false);const inputRef=React.useRef<HTMLInputElement>(null);
  async function upload() {
    if (!file || pending) return;
    setPending(true);setError(null);
    try {
      const body=new FormData();body.set("file",file);body.set("internal",String(internal));
      const response=await fetch(`/api/support/${ticketId}/attachments`,{method:"POST",body});
      const result=await response.json();
      if (!response.ok) throw new Error(result.error??"The attachment could not be saved.");
      setFile(null);if(inputRef.current)inputRef.current.value="";router.refresh();
    } catch(error) {setError(error instanceof Error?error.message:"Please try again.");}
    finally {setPending(false);}
  }
  return <Card className="space-y-4 p-4 sm:p-5">
    <div className="flex items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink-2" aria-hidden><Paperclip className="size-4"/></span>
      <h2 className="text-[15px] font-semibold tracking-tight text-ink">Attachments</h2>
      {attachments.length>0&&<span className="rounded-md bg-surface-3 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2">{attachments.length}</span>}
    </div>
    {attachments.length?<ul className="space-y-2">{attachments.map((attachment)=><li key={attachment.id}>
      <a href={`/api/support/attachments/${attachment.id}`} className="management-row flex min-w-0 items-center gap-3 rounded-xl border border-line bg-surface-2/60 px-3 py-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-primary">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-muted ring-1 ring-inset ring-line" aria-hidden>{isImage(attachment.filename)?<FileImage className="size-4"/>:<FileText className="size-4"/>}</span>
        <span className="min-w-0 flex-1 break-words font-medium text-ink" title={attachment.filename}>{attachment.filename}</span>
        {attachment.visibility==="internal"&&<StatusPill tone="warning" size="sm" icon={<Lock className="size-3" aria-hidden/>}>Internal</StatusPill>}
        <InfoChip>{formatBytes(attachment.size_bytes)}</InfoChip>
      </a></li>)}</ul>:<div className="rounded-xl border border-dashed border-line-strong"><EmptyState compact icon={<Paperclip className="size-5"/>} title="No attachments yet" description={closed?"Files can no longer be added to a closed request.":"Add a document or screenshot below and it stays with this conversation."}/></div>}
    {!closed&&<div className="space-y-3 border-t border-line pt-4">
      <input ref={inputRef} id={`attach-${ticketId}`} type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" disabled={pending} onChange={(event)=>setFile(event.target.files?.[0]??null)} className="sr-only"/>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={()=>inputRef.current?.click()}><Upload className="size-3.5" aria-hidden/>{file?"Change file":"Choose a file"}</Button>
        {file?<InfoChip icon={<FileText/>} className="h-8 max-w-full"><span title={file.name}>{file.name}</span> · {formatBytes(file.size)}</InfoChip>:<span className="text-[12.5px] text-muted">PDF, PNG, JPG or TXT, up to 10 MB</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          {audience==="agency"&&<label className={cn("inline-flex h-11 cursor-pointer items-center gap-2.5 rounded-xl border px-3 text-[12.5px] font-medium transition sm:h-8",internal?"border-warning/40 bg-warning-soft text-warning-ink":"border-line bg-surface-2/60 text-ink-2 hover:border-line-strong")}><Switch checked={internal} onCheckedChange={setInternal} aria-label="Agency only"/>Agency only</label>}
          <Button size="sm" loading={pending} disabled={!file} onClick={upload}>Upload</Button>
        </div>
      </div>
    </div>}
    {error&&<p role="alert" className="flex items-start gap-2 rounded-xl border border-danger/20 bg-danger-soft px-3 py-2.5 text-[13px] leading-relaxed text-danger-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden/>{error}</p>}
  </Card>;
}
