import { type OnboardingData,websiteLooksValid } from "@/lib/agent-settings";
import { AGENT_BY_KEY,type AgentRoleKey } from "@/lib/agents";
export interface OnboardingQuestion { id:string;phase:number;title:string;description:string;optional:boolean;role?:AgentRoleKey;answerId?:string }
export function onboardingQuestions(data:OnboardingData,enabledRoles:AgentRoleKey[]):OnboardingQuestion[] {
  return [
    {id:"companyName",phase:1,title:"What's your company called?",description:"Use the name your customers know. This becomes the identity of your workspace.",optional:false},
    {id:"description",phase:1,title:"Tell us what your business does.",description:"A sentence or two is enough. Explain what you help people with, in your own words.",optional:false},
    {id:"industry",phase:1,title:"Which industry are you in?",description:"This gives your AI team useful context for your customers and market.",optional:true},
    {id:"website",phase:1,title:"Where can we find you online?",description:"Add your website so our team can understand your business. You can add this later.",optional:true},
    {id:"operatingArea",phase:1,title:"Where do you work?",description:"Share the cities, regions or countries you serve.",optional:true},
    {id:"services",phase:1,title:"What do you offer your customers?",description:"List your main products or services. A short, simple list works well.",optional:true},
    {id:"idealCustomers",phase:1,title:"Who is your ideal customer?",description:"Describe the people or businesses you'd like your team to focus on.",optional:true},
    {id:"goals",phase:2,title:"What would you like to improve?",description:"Choose the outcomes that matter most. You can select more than one.",optional:false},
    {id:"tone",phase:3,title:"How should your AI team sound?",description:"Choose a voice that feels like your business. You'll see a short example for each option.",optional:true},
    {id:"replyLength",phase:3,title:"How much detail should replies include?",description:"A useful default for everyday conversations. Individual employees can be adjusted later.",optional:true},
    {id:"language",phase:3,title:"Which language should your team use?",description:"Choose the default language for your company's AI employees.",optional:true},
    {id:"companyRules",phase:3,title:"Any important company rules?",description:"Share a policy or preference your employees should keep in mind.",optional:true},
    {id:"neverPromise",phase:3,title:"What should your team never promise?",description:"Help your AI employees stay clear and accurate about prices, timing and outcomes.",optional:true},
    {id:"escalateWhen",phase:3,title:"When should a human step in?",description:"Tell us when your AI employees should ask your team for help.",optional:true},
    {id:"workforce",phase:4,title:"Choose your AI team.",description:"Select the employees you'd like to configure now. Only employees included in your package can be selected.",optional:false},
    ...data.workforce.selected.filter((role):role is AgentRoleKey=>enabledRoles.includes(role as AgentRoleKey)).flatMap(role=>AGENT_BY_KEY[role].questions.map(question=>({id:`${role}:${question.id}`,phase:4,title:question.label,description:question.help??`A little direction for your ${AGENT_BY_KEY[role].shortName}. Skip this if you're not sure yet.`,optional:true,role,answerId:question.id}))),
    {id:"review",phase:5,title:"Your team, shaped around your business.",description:"Review your answers before we prepare the employee configurations. Nothing starts customer outreach.",optional:false},
  ];
}
export function onboardingQuestionError(id:string,data:OnboardingData):string|null {
  if(id==="companyName"&&data.business.companyName.trim().length<2)return "Add your company name.";
  if(id==="description"&&data.business.description.trim().length<10)return "A sentence or two is perfect.";
  if(id==="website"&&!websiteLooksValid(data.business.website.trim()))return "That website address doesn't look right.";
  if(id==="goals"&&!data.goals.selected.length)return "Choose at least one goal.";
  if(id==="workforce"&&!data.workforce.selected.length)return "Choose at least one AI employee.";
  return null;
}

/** Older autosaves must finish before the final snapshot used to generate configurations. */
export function createOnboardingSaveQueue<T>(save:(step:number,data:OnboardingData)=>Promise<T>) {
  let pending:Promise<unknown>=Promise.resolve();
  return (step:number,data:OnboardingData):Promise<T>=>{
    const result=pending.then(()=>save(step,data));
    // A failed network request must not prevent later edits or an explicit retry from saving.
    pending=result.catch(()=>undefined);
    return result;
  };
}

type PositionStorage=Pick<Storage,"getItem"|"setItem"|"removeItem">;
const positionKey=(resumeKey:string)=>`iaq-onboarding-position:${resumeKey}`;

/** Browser storage is an optional position hint; business answers stay on the server. */
export function restoreOnboardingPosition(getStorage:()=>PositionStorage,resumeKey:string,questions:OnboardingQuestion[]) {
  try {
    const id=getStorage().getItem(positionKey(resumeKey));
    return questions.find(question=>question.id===id)??null;
  } catch { return null; }
}

export function rememberOnboardingPosition(getStorage:()=>PositionStorage,resumeKey:string,questionId:string|null) {
  try {
    const storage=getStorage();
    if(questionId===null)storage.removeItem(positionKey(resumeKey));
    else storage.setItem(positionKey(resumeKey),questionId);
  } catch { /* Private browsing or full storage must never block server persistence. */ }
}
