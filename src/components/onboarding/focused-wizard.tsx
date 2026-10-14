"use client";
import * as React from "react";
import { AnimatePresence,motion,useReducedMotion } from "motion/react";
import { ArrowLeft,ArrowRight,Check,Cloud,LifeBuoy,Loader2,ShieldCheck,Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field,Input,Select,Textarea } from "@/components/ui/primitives";
import { AgentAvatar } from "@/components/brand";
import { openHelp } from "@/components/help/help-widget";
import { GeneratedSummary } from "@/components/onboarding/wizard";
import { saveOnboardingAction,completeOnboardingAction } from "@/app/actions/onboarding";
import { BUSINESS_GOALS,LANGUAGES,LENGTH_COPY,TONE_COPY,TONES,type OnboardingData } from "@/lib/agent-settings";
import { AGENT_BY_KEY,AGENT_ROLES,type AgentRoleKey } from "@/lib/agents";
import { createOnboardingSaveQueue,onboardingQuestions,onboardingQuestionError,rememberOnboardingPosition,restoreOnboardingPosition } from "@/lib/onboarding-flow";
import { cn } from "@/lib/utils";

const PHASES=["Business","Goals","Voice","AI team","Review"];
const INDUSTRIES=["Home services","Real estate","Dental","Medical & wellness","Legal","Financial services","Marketing agency","Software & SaaS","Construction","Automotive","Education","Hospitality","Retail & e-commerce","Professional services","Other"];
type GeneratedEmployee={role:AgentRoleKey;name:string;summary:string;configStatus:string;agentStatus:string};
export function FocusedOnboarding({initialData,initialStep,enabledRoles,completedAt,resumeKey}:{initialData:OnboardingData;initialStep:number;enabledRoles:AgentRoleKey[];completedAt:string|null;resumeKey:string}) {
  const reduced=useReducedMotion();const [data,setData]=React.useState(initialData);const [step,setStep]=React.useState(Math.min(5,Math.max(1,initialStep)));
  const initialQuestions=React.useMemo(()=>onboardingQuestions(initialData,enabledRoles),[initialData,enabledRoles]);
  const [questionId,setQuestionId]=React.useState(initialQuestions.find(q=>q.phase===Math.min(5,Math.max(1,initialStep)))?.id??"companyName");
  const [direction,setDirection]=React.useState(1);const [error,setError]=React.useState<string|null>(null);
  const [saveState,setSaveState]=React.useState("idle");const [generating,setGenerating]=React.useState(false);const [result,setResult]=React.useState<GeneratedEmployee[]|null>(null);
  const [saveAttempt,setSaveAttempt]=React.useState(0);
  const [saveProgress]=React.useState(()=>createOnboardingSaveQueue(saveOnboardingAction));
  const generatingRef=React.useRef(false);
  const autosaveTimer=React.useRef<ReturnType<typeof setTimeout>|null>(null);
  const lastSaved=React.useRef(JSON.stringify([step,initialData]));
  const questions=onboardingQuestions(data,enabledRoles);const index=Math.max(0,questions.findIndex(q=>q.id===questionId));const question=questions[index];
  React.useEffect(()=>{
    if(generating||result)return;
    const payload=JSON.stringify([step,data]);if(payload===lastSaved.current)return;
    let active=true;
    const timer=setTimeout(async()=>{
      if(generatingRef.current)return;
      setSaveState("saving");
      try {
        const saved=await saveProgress(step,data);
        if(saved.ok)lastSaved.current=payload;
        if(!active||generatingRef.current)return;
        setSaveState(saved.ok?"saved":"error");if(!saved.ok)toast.error(saved.error);
      } catch {
        if(active&&!generatingRef.current){setSaveState("error");toast.error("Your progress couldn't be saved. Please try again.");}
      }
    },700);
    autosaveTimer.current=timer;
    return()=>{active=false;clearTimeout(timer);if(autosaveTimer.current===timer)autosaveTimer.current=null;};
  },[data,step,generating,result,saveProgress,saveAttempt]);
  React.useEffect(()=>{
    const stored=restoreOnboardingPosition(()=>window.localStorage,resumeKey,initialQuestions);
    if(!stored)return;
    const frame=window.requestAnimationFrame(()=>{setQuestionId(stored.id);setStep(stored.phase);});return()=>window.cancelAnimationFrame(frame);
    // Only question identifiers are stored locally. All business answers remain persisted on the server.
  },[resumeKey,initialQuestions]);
  function move(nextIndex:number,skip=false) {
    if(generatingRef.current)return;
    if(nextIndex>index&&!skip){const problem=onboardingQuestionError(question.id,data);if(problem){setError(problem);return;}}
    const next=questions[Math.min(questions.length-1,Math.max(0,nextIndex))];setDirection(nextIndex>index?1:-1);setQuestionId(next.id);setStep(next.phase);setError(null);
    rememberOnboardingPosition(()=>window.localStorage,resumeKey,next.id);
    window.scrollTo({top:0,behavior:reduced?"auto":"smooth"});
  }
  function business(key:keyof OnboardingData["business"],value:string){setData(current=>({...current,business:{...current.business,[key]:value}}));}
  function communication(key:keyof OnboardingData["communication"],value:string){setData(current=>({...current,communication:{...current.communication,[key]:value}}));}
  async function generate(){
    if(generatingRef.current)return;
    for(const required of ["companyName","description","website","goals","workforce"]){const problem=onboardingQuestionError(required,data);if(problem){const target=questions.findIndex(q=>q.id===required);move(target,true);setError(problem);return;}}
    generatingRef.current=true;setGenerating(true);setError(null);
    if(autosaveTimer.current){clearTimeout(autosaveTimer.current);autosaveTimer.current=null;}
    let finalSaved=false;
    try {
      const saved=await saveProgress(5,data);
      if(!saved.ok){setSaveState("error");setError(saved.error);return;}
      finalSaved=true;lastSaved.current=JSON.stringify([5,data]);setSaveState("saved");
      const generated=await completeOnboardingAction();
      if(!generated.ok){setError(generated.error);return;}
      rememberOnboardingPosition(()=>window.localStorage,resumeKey,null);
      setResult(generated.data.employees as GeneratedEmployee[]);
    } catch {if(!finalSaved)setSaveState("error");setError("We couldn't prepare your configurations. Your answers are still here; please try again.");}
    finally {generatingRef.current=false;setGenerating(false);}
  }
  function renderQuestion(){
    if(question.role&&question.answerId){const role=AGENT_BY_KEY[question.role];const answer=role.questions.find(q=>q.id===question.answerId);return <div className="space-y-5"><div className="flex items-center gap-3 rounded-xl bg-surface-2 p-3"><AgentAvatar role={role} size="md"/><span className="text-[13px] font-medium">{role.name}</span></div><Field label="Your direction" htmlFor="onboarding-answer"><Textarea id="onboarding-answer" value={data.workforce.answers[question.role]?.[question.answerId]??""} maxLength={1000} placeholder={answer?.placeholder} onChange={event=>setData(current=>({...current,workforce:{...current.workforce,answers:{...current.workforce.answers,[question.role!]:{...current.workforce.answers[question.role!],[question.answerId!]:event.target.value}}}}))}/></Field></div>;}
    if(question.id==="goals")return <div className="space-y-4"><div className="grid gap-2 sm:grid-cols-2">{BUSINESS_GOALS.map(goal=>{const selected=data.goals.selected.includes(goal.id);return <button key={goal.id} aria-pressed={selected} onClick={()=>setData(current=>({...current,goals:{...current.goals,selected:selected?current.goals.selected.filter(value=>value!==goal.id):[...current.goals.selected,goal.id]}}))} className={cn("flex min-h-14 items-center gap-3 rounded-xl border px-4 py-3 text-left text-[14px] transition",selected?"border-primary bg-primary-soft text-primary-ink":"border-line bg-surface hover:border-primary/30")}><span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md border",selected?"border-primary bg-primary text-white":"border-line-strong")}>{selected&&<Check className="size-3"/>}</span>{goal.label}</button>;})}</div>{data.goals.selected.includes("other")&&<Field label="Another goal" htmlFor="onboarding-other"><Input id="onboarding-other" maxLength={300} value={data.goals.other} onChange={event=>setData(current=>({...current,goals:{...current.goals,other:event.target.value}}))}/></Field>}</div>;
    if(question.id==="tone")return <div className="grid gap-3 sm:grid-cols-2">{TONES.map(tone=><button key={tone} aria-pressed={data.communication.tone===tone} onClick={()=>communication("tone",tone)} className={cn("rounded-2xl border p-4 text-left transition",data.communication.tone===tone?"border-primary bg-primary-soft/60":"border-line bg-surface")}><span className="flex justify-between font-semibold">{TONE_COPY[tone].label}{data.communication.tone===tone&&<Check className="size-4 text-primary"/>}</span><span className="mt-2 block text-[13px] leading-relaxed text-muted">“{TONE_COPY[tone].example}”</span></button>)}</div>;
    if(question.id==="replyLength")return <div className="space-y-3">{(["concise","balanced","detailed"]as const).map(length=><button key={length} aria-pressed={data.communication.replyLength===length} onClick={()=>communication("replyLength",length)} className={cn("flex w-full items-start gap-3 rounded-xl border p-4 text-left",data.communication.replyLength===length?"border-primary bg-primary-soft/50":"border-line bg-surface")}><span className="min-w-0 flex-1"><strong className="text-[14px]">{LENGTH_COPY[length].label}</strong><span className="mt-1 block text-[13px] text-muted">{LENGTH_COPY[length].description}</span></span>{data.communication.replyLength===length&&<Check className="size-4 text-primary"/>}</button>)}</div>;
    if(question.id==="language")return <Field label="Language" htmlFor="onboarding-language"><Select id="onboarding-language" value={data.communication.language} onChange={event=>communication("language",event.target.value)}>{LANGUAGES.map(language=><option key={language}>{language}</option>)}</Select></Field>;
    if(question.id==="workforce")return <div className="grid gap-3 sm:grid-cols-2">{AGENT_ROLES.map(role=>{const included=enabledRoles.includes(role.key);const selected=included&&data.workforce.selected.includes(role.key);return <button key={role.key} disabled={!included} aria-pressed={selected} onClick={()=>setData(current=>({...current,workforce:{...current.workforce,selected:selected?current.workforce.selected.filter(key=>key!==role.key):[...current.workforce.selected,role.key]}}))} className={cn("flex items-center gap-3 rounded-2xl border p-4 text-left",selected?"border-primary bg-primary-soft/40":"border-line bg-surface",!included&&"opacity-50")}><AgentAvatar role={role} size="lg"/><span className="min-w-0 flex-1"><strong className="block text-[13px]">{role.shortName}</strong><span className="mt-1 block text-[11px] leading-relaxed text-muted">{included?role.tagline:"Not included in your package"}</span></span>{selected&&<Check className="size-4 shrink-0 text-primary"/>}</button>;})}</div>;
    if(question.id==="review")return <div className="space-y-5"><dl className="divide-y divide-line rounded-2xl border border-line bg-surface">{[{label:"Your business",value:data.business.companyName,question:"companyName"},{label:"What you do",value:data.business.description,question:"description"},{label:"Your goals",value:data.goals.selected.map(id=>BUSINESS_GOALS.find(goal=>goal.id===id)?.label).filter(Boolean).join(", "),question:"goals"},{label:"Voice",value:`${TONE_COPY[data.communication.tone].label} · ${LENGTH_COPY[data.communication.replyLength].label} · ${data.communication.language}`,question:"tone"},{label:"AI employees",value:data.workforce.selected.map(role=>AGENT_BY_KEY[role as AgentRoleKey]?.shortName).filter(Boolean).join(", "),question:"workforce"}].map(item=><div key={item.label} className="flex gap-4 p-4"><div className="min-w-0 flex-1"><dt className="text-[11px] font-medium uppercase tracking-wider text-muted">{item.label}</dt><dd className="mt-1 text-[14px] leading-relaxed text-ink">{item.value||"Not provided"}</dd></div><button onClick={()=>move(questions.findIndex(q=>q.id===item.question),true)} className="self-start text-[12px] font-medium text-primary">Edit</button></div>)}</dl>{completedAt&&<p className="rounded-xl bg-warning-soft p-4 text-[13px] leading-relaxed text-warning-ink">Your company setup already exists. Preparing your team again saves a new configuration version. Earlier versions remain in each employee&apos;s history.</p>}<div className="flex items-start gap-3 rounded-xl bg-primary-soft/50 p-4"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary"/><p className="text-[13px] leading-relaxed text-ink-2">Your company profile and employee configurations will be saved. Our team handles secure connections and verifies readiness before any activation.</p></div><Button variant="brand" size="lg" className="w-full" loading={generating} onClick={generate}><Sparkles className="size-4"/>{generating?"Preparing your configurations…":"Prepare my AI team"}</Button></div>;
    if(question.id==="industry")return <Field label="Industry" htmlFor="onboarding-industry"><Select id="onboarding-industry" value={data.business.industry} onChange={event=>business("industry",event.target.value)}><option value="">Choose an industry</option>{INDUSTRIES.map(industry=><option key={industry}>{industry}</option>)}</Select></Field>;
    const businessFields:Record<string,{label:string;placeholder:string;multiline?:boolean;max:number}>={companyName:{label:"Company name",placeholder:"Your company name",max:120},description:{label:"Business description",placeholder:"We help homeowners in Austin with roof repairs and inspections.",multiline:true,max:2000},website:{label:"Website",placeholder:"yourcompany.com",max:300},operatingArea:{label:"Service area",placeholder:"Austin, TX and surrounding counties",max:500},services:{label:"Products and services",placeholder:"Roof inspections, repairs and gutter replacement",multiline:true,max:2000},idealCustomers:{label:"Ideal customers",placeholder:"Homeowners who need a reliable roof repair specialist",multiline:true,max:2000}};
    const field=businessFields[question.id];if(field){const value=data.business[question.id as keyof OnboardingData["business"]];return <Field label={field.label} htmlFor="onboarding-answer" error={error}>{field.multiline?<Textarea id="onboarding-answer" rows={5} maxLength={field.max} value={value} placeholder={field.placeholder} onChange={event=>business(question.id as keyof OnboardingData["business"],event.target.value)}/>:<Input id="onboarding-answer" maxLength={field.max} value={value} placeholder={field.placeholder} onChange={event=>business(question.id as keyof OnboardingData["business"],event.target.value)}/>}</Field>;}
    const key=question.id as "companyRules"|"neverPromise"|"escalateWhen";const prompts={companyRules:"Always offer a free inspection first.",neverPromise:"Exact prices before an assessment, guaranteed results or same-day service.",escalateWhen:"A customer is upset, or a question involves pricing or contracts."};
    return <Field label="Your guidance" htmlFor="onboarding-answer"><Textarea id="onboarding-answer" rows={4} maxLength={key==="companyRules"?1500:key==="neverPromise"?1000:600} value={data.communication[key]} placeholder={prompts[key]} onChange={event=>communication(key,event.target.value)}/></Field>;
  }
  if(result)return <GeneratedSummary employees={result}/>;
  return <main className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6"><div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10">
    <aside className="self-start rounded-[24px] bg-[#11192c] p-6 text-white lg:sticky lg:top-6"><p className="text-[10px] font-semibold uppercase tracking-[.18em] text-blue-200">Built around you</p><h2 className="mt-3 text-[25px] font-semibold leading-tight tracking-tight">Let&apos;s make this<br/>your workspace.</h2><p className="mt-3 text-[13px] leading-relaxed text-slate-300">One question at a time. A team that understands your business.</p><ol className="mt-6 flex flex-wrap gap-2 lg:block lg:space-y-4">{PHASES.map((phase,phaseIndex)=><li key={phase}><button onClick={()=>move(questions.findIndex(q=>q.phase===phaseIndex+1),true)} disabled={generating||phaseIndex+1>step} className={cn("flex min-h-10 items-center gap-3 rounded-xl px-2 text-left text-[13px]",question.phase===phaseIndex+1?"font-medium text-white":"text-slate-300 disabled:opacity-50")} aria-current={question.phase===phaseIndex+1?"step":undefined}><span className={cn("flex size-6 items-center justify-center rounded-full border text-[10px]",question.phase===phaseIndex+1?"border-blue-300 bg-blue-400/20":"border-white/20")}>{phaseIndex+1<question.phase?<Check className="size-3"/>:String(phaseIndex+1).padStart(2,"0")}</span>{phase}</button></li>)}</ol><button onClick={()=>openHelp("chat")} className="mt-6 flex items-center gap-2 text-[12px] text-blue-200"><LifeBuoy className="size-4"/>A little help from iAcquire</button></aside>
    <div className="min-w-0"><div className="mb-5 flex items-center justify-between gap-3 text-[12px]"><span className="font-medium text-muted">Question {index+1} of {questions.length}</span><span role="status" className="flex items-center gap-1.5 text-muted">{saveState==="saving"?<><Loader2 className="size-3.5 animate-spin"/>Saving…</>:saveState==="error"?<button type="button" disabled={generating} onClick={()=>setSaveAttempt(attempt=>attempt+1)} className="text-danger-ink underline underline-offset-2">Couldn&apos;t save — retry</button>:<><Cloud className="size-3.5"/>{saveState==="saved"?"Saved to your workspace":"Your progress is saved as you go"}</>}</span></div><div className="mb-6 h-1.5 overflow-hidden rounded-full bg-surface-3"><motion.div initial={false} animate={{width:`${(index+1)/questions.length*100}%`}} className="h-full rounded-full bg-primary" transition={{duration:reduced?0:.35}}/></div>
      <AnimatePresence mode="wait"><motion.section key={question.id} initial={reduced?false:{opacity:0,x:direction*14}} animate={{opacity:1,x:0}} exit={reduced?undefined:{opacity:0,x:direction*-14}} transition={{duration:.2}} className="rounded-[24px] border border-line bg-surface p-5 shadow-card sm:p-8"><div className="mb-6"><p className="text-[10px] font-semibold uppercase tracking-[.15em] text-primary">{PHASES[question.phase-1]} · {question.optional?"Optional":"Required"}</p><h1 className="mt-3 text-[26px] font-semibold leading-tight tracking-[-.035em] sm:text-[30px]">{question.title}</h1><p className="mt-3 text-[14px] leading-relaxed text-muted">{question.description}</p></div><fieldset disabled={generating} aria-busy={generating||undefined} className="m-0 min-w-0 border-0 p-0">{renderQuestion()}</fieldset>{error&&!(["companyName","description","website","operatingArea","services","idealCustomers"].includes(question.id))&&<p role="alert" className="mt-4 text-[13px] text-danger-ink">{error}</p>}</motion.section></AnimatePresence>
      <div className="mt-5 flex flex-wrap items-center gap-3"><Button variant="ghost" disabled={generating||index===0} onClick={()=>move(index-1,true)}><ArrowLeft className="size-4"/>Back</Button>{question.id!=="review"&&<><span className="flex-1"/>{question.optional&&<Button variant="ghost" disabled={generating} onClick={()=>move(index+1,true)}>Skip for now</Button>}<Button variant="brand" disabled={generating} onClick={()=>move(index+1)}>Next<ArrowRight className="size-4"/></Button></>}</div>
    </div>
  </div></main>;
}

