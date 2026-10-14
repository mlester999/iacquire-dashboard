"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { FileText, Lock, Paperclip } from "lucide-react";
import { Card } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";

interface Attachment { id:string; filename:string; size_bytes:number; visibility:"client"|"internal" }
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
  return <Card className="space-y-3 p-4">
    <h2 className="flex items-center gap-2 text-[14px] font-semibold"><Paperclip className="size-4 text-muted"/>Attachments</h2>
    {attachments.length?<ul className="space-y-2">{attachments.map((attachment)=><li key={attachment.id}>
      <a href={`/api/support/attachments/${attachment.id}`} className="flex min-w-0 items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] hover:bg-surface-3 focus-visible:outline-primary">
        <FileText className="size-4 shrink-0 text-muted"/><span className="min-w-0 flex-1 break-all">{attachment.filename}</span>
        {attachment.visibility==="internal"&&<span className="flex shrink-0 items-center gap-1 text-[11px] text-muted"><Lock className="size-3"/>Internal</span>}
        <span className="shrink-0 text-[11px] text-faint">{Math.ceil(attachment.size_bytes/1024)} KB</span>
      </a></li>)}</ul>:<p className="text-[13px] text-muted">No attachments yet.</p>}
    {!closed&&<div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
      <label className="min-w-0 flex-1 text-[12px] text-muted">Add a document or screenshot (up to 10 MB)
        <input ref={inputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" disabled={pending} onChange={(event)=>setFile(event.target.files?.[0]??null)} className="mt-1 block w-full min-w-0 text-[12px] file:mr-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-2 file:text-ink"/>
      </label>
      {audience==="agency"&&<label className="flex items-center gap-2 text-[12px] text-muted"><input type="checkbox" checked={internal} onChange={(event)=>setInternal(event.target.checked)}/>Agency only</label>}
      <Button size="sm" loading={pending} disabled={!file} onClick={upload}>Upload</Button>
    </div>}
    {error&&<p role="alert" className="text-[13px] text-danger">{error}</p>}
  </Card>;
}
