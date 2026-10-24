// What a prospect is told before they ask for the demo. DRAFT wording for counsel: the demo must not be switched on for real visitors until counsel has approved it (the version in
// rules.ts, NOTICE_VERSION, is recorded with each request and must change whenever this text does). Pure.
import { NOTICE_VERSION } from "./rules";

export { NOTICE_VERSION };

export interface DemoNotice {
  version: string;
  /** The sentence beside the required tick box. */
  consent: string;
  /** The optional tick box. Never ticked for them. */
  marketing: string;
  /** What is kept and for how long, shown under the form. */
  details: string[];
}

export function demoNotice(retentionDays: number): DemoNotice {
  return {
    version: NOTICE_VERSION,
    consent: "I agree that iAcquire may email me a link to this demo and keep my details and the demo conversation, so the team can follow up if I ask.",
    marketing: "Also send me occasional emails about iAcquire (optional).",
    details: [
      "We keep your name, work email address, business name and the demo conversation for up to " + retentionDays + " days after your demo ends, then erase them.",
      "You can ask us to erase them sooner at any time.",
      "The demo uses sample data only. Nothing you type is sent to a customer, and no real workspace is created.",
    ],
  };
}
