import { Bot,Code2,Globe,ImageIcon,Workflow,Layers } from "lucide-react";
import { cn } from "@/lib/utils";

/** Branded structural illustration, explicitly labelled as missing media; never a project screenshot. */
export function ProjectMediaPlaceholder({title,technologies=[],className}:{title:string;technologies?:string[];className?:string}) {
  const tech=technologies.join(" ").toLowerCase();const Icon=/n8n|zapier|make|ghl/.test(tech)?Workflow:/ai|gpt|rag|agent/.test(tech)?Bot:/shopify|web|liquid/.test(tech)?Globe:Code2;
  return <div className={cn("relative flex aspect-[16/10] min-w-0 flex-col justify-between overflow-hidden bg-[#101729] p-5 text-white",className)}>
    <div aria-hidden className="pointer-events-none absolute inset-0 opacity-20" style={{backgroundImage:"linear-gradient(rgba(148,163,184,.22) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.22) 1px,transparent 1px)",backgroundSize:"32px 32px"}}/>
    <div className="relative flex items-center justify-between"><span className="text-[12px] font-semibold uppercase tracking-[.18em] text-blue-200/80">iAcquire / Selected work</span><Icon className="size-5 text-blue-300" aria-hidden/></div>
    <div className="relative my-3 flex items-center justify-center gap-3" aria-hidden><div className="flex size-10 items-center justify-center rounded-xl border border-white/15 bg-white/5"><Layers className="size-4 text-slate-300"/></div><span className="h-px w-8 bg-gradient-to-r from-blue-400/20 to-blue-400"/><span className="flex size-[68px] items-center justify-center rounded-2xl border border-blue-300/30 bg-gradient-to-br from-blue-500/20 to-indigo-500/25 shadow-[0_0_35px_rgba(59,130,246,.12)]"><Icon className="size-7 text-blue-200"/></span><span className="h-px w-8 bg-gradient-to-r from-blue-400 to-blue-400/20"/><div className="size-10 rounded-xl border border-white/15 bg-white/5"><span className="mx-auto mt-3 block h-1 w-5 rounded bg-slate-400/40"/><span className="mx-auto mt-1.5 block h-1 w-4 rounded bg-slate-400/30"/></div></div>
    <div className="relative"><p className="line-clamp-2 text-sm font-semibold leading-snug text-white">{title}</p><p className="mt-2 flex items-center gap-1.5 text-[12px] text-slate-300"><ImageIcon className="size-3" aria-hidden/>Project screenshots not available</p></div>
  </div>;
}

export function TechnologyPill({name}:{name:string}){return <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] font-medium text-ink-2"><span aria-hidden className={cn("size-1.5 rounded-full",/ai|gpt|anthropic|agent/i.test(name)?"bg-violet":/n8n|make|zapier/i.test(name)?"bg-warning":/supabase|node|python/i.test(name)?"bg-success":"bg-primary")}/>{name}</span>;}

/** "ai-automation" -> "AI automation": category slugs read as labels, never raw. */
export function categoryLabel(slug: string) {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.replace(/\b(ai|crm|api|sms|seo)\b/gi, (w) => w.toUpperCase()).replace(/^./, (c) => c.toUpperCase());
}
