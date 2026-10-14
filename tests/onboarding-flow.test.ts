import { describe,expect,it,vi } from "vitest";
import { onboardingSchema,type OnboardingData } from "@/lib/agent-settings";
import { createOnboardingSaveQueue,onboardingQuestions,rememberOnboardingPosition,restoreOnboardingPosition } from "@/lib/onboarding-flow";

function answers(companyName:string):OnboardingData {
  const data=onboardingSchema.parse({});
  return {...data,business:{...data.business,companyName},workforce:{selected:["lead_hunter"],answers:{}}};
}
function memoryStorage() {
  const values=new Map<string,string>();
  return {values,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
}

describe("focused onboarding persistence",()=>{
  it("finishes an older autosave before the final snapshot used for generation",async()=>{
    let release!:()=>void;
    const slowSave=new Promise<void>(resolve=>{release=resolve;});
    const calls:number[]=[];
    let persisted="";
    const save=createOnboardingSaveQueue(async(step,data)=>{
      calls.push(step);
      if(step===1)await slowSave;
      persisted=data.business.companyName;
      return {ok:true};
    });
    const older=save(1,answers("Old answer"));
    const final=save(5,answers("Final answer"));
    const generated=final.then(()=>persisted);
    await Promise.resolve();
    expect(calls).toEqual([1]);
    release();await older;
    expect(await generated).toBe("Final answer");
    expect(calls).toEqual([1,5]);
    expect(persisted).toBe("Final answer");
  });

  it("allows queued edits and an explicit retry after a transport failure",async()=>{
    const persist=vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ok:true});
    const save=createOnboardingSaveQueue(persist);
    const failed=save(1,answers("Initial answer"));
    const retry=save(1,answers("Retried answer"));
    await expect(failed).rejects.toThrow("offline");
    await expect(retry).resolves.toEqual({ok:true});
    expect(persist).toHaveBeenNthCalledWith(2,1,answers("Retried answer"));
  });

  it("restores the matching server phase with the question position",()=>{
    const storage=memoryStorage();
    rememberOnboardingPosition(()=>storage,"organization-a","workforce");
    const position=restoreOnboardingPosition(()=>storage,"organization-a",onboardingQuestions(answers("A"),["lead_hunter"]));
    expect(position).toMatchObject({id:"workforce",phase:4});
    expect(restoreOnboardingPosition(()=>storage,"organization-b",onboardingQuestions(answers("B"),["lead_hunter"]))).toBeNull();
  });

  it("ignores a resume question for an employee no longer included in the package",()=>{
    const storage=memoryStorage();
    const data=answers("A");
    const question=onboardingQuestions(data,["lead_hunter"]).find(item=>item.role==="lead_hunter")!;
    rememberOnboardingPosition(()=>storage,"organization-a",question.id);
    expect(restoreOnboardingPosition(()=>storage,"organization-a",onboardingQuestions(data,[]))).toBeNull();
  });

  it("works when access to localStorage itself is denied",()=>{
    const denied=()=>{throw new Error("Storage access denied");};
    expect(restoreOnboardingPosition(denied,"organization-a",onboardingQuestions(answers("A"),["lead_hunter"]))).toBeNull();
    expect(()=>rememberOnboardingPosition(denied,"organization-a","review")).not.toThrow();
    expect(()=>rememberOnboardingPosition(denied,"organization-a",null)).not.toThrow();
  });

  it("ignores failed read, write and cleanup operations",()=>{
    const fail=()=>{throw new Error("Quota or privacy restriction");};
    const storage={getItem:fail,setItem:fail,removeItem:fail};
    expect(restoreOnboardingPosition(()=>storage,"organization-a",[])).toBeNull();
    expect(()=>rememberOnboardingPosition(()=>storage,"organization-a","review")).not.toThrow();
    expect(()=>rememberOnboardingPosition(()=>storage,"organization-a",null)).not.toThrow();
  });

  it("stores only the position hint and removes only that hint after completion",()=>{
    const storage=memoryStorage();
    storage.setItem("unrelated-preference","keep");
    rememberOnboardingPosition(()=>storage,"organization-a","review");
    expect(storage.values.get("iaq-onboarding-position:organization-a")).toBe("review");
    rememberOnboardingPosition(()=>storage,"organization-a",null);
    expect([...storage.values.entries()]).toEqual([["unrelated-preference","keep"]]);
  });
});
