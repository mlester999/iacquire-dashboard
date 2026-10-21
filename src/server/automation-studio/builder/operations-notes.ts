import "server-only";
import { MAX_OPERATIONS_PER_BATCH } from "@/lib/crm/workflow/operations";

/** The operation language, as the builder is taught it. Kept beside the schema it describes (src/lib/crm/workflow/operations.ts). */
export const OPERATION_FORMAT_NOTES = `OPERATIONS (a JSON array, at most ${MAX_OPERATIONS_PER_BATCH} per reply; they are applied in order, all together or not at all)
- {"op":"add_step","kind":<step kind>,"key":<optional new key>,"name":<optional label>,"config":{...},"requireApproval":<optional boolean>,"at":<where>}
    where: {"after":null} = first step; {"after":"<key>","via":"next"} = after a plain step; {"after":"<key>","via":"yes"|"no"} = on a path of an if / else. Whatever followed that point follows the new step.
- {"op":"update_step","key":"<key>","name":<string|null>,"config":{<only the settings that change>},"requireApproval":<boolean>}   (settings are merged into the current ones)
- {"op":"remove_step","key":"<key>"}   (what led to it continues with what followed it; removing an if / else also removes its two paths)
- {"op":"move_step","key":"<key>","direction":"up"|"down"}   (swaps a plain step with its neighbour)
- {"op":"connect","from":"<key>","via":"next"|"yes"|"no","to":"<key>"|null}   (null ends that path)
- {"op":"set_entry","key":"<key>"}   (this step runs first)
- {"op":"set_trigger","trigger":{...}}  or  {"op":"patch_trigger","patch":{...}}   (patch replaces top-level keys, merges "filters", and null removes a key)
Rules: step "key" values are unique and stable; refer to existing steps by their exact key from the workflow below. "Make that two days" means update_step on the wait step, not a new step. Give steps short human names ("Wait 2 days", "Text the lead") with "name". Put a wait before any follow-up that should not happen immediately. An if / else needs its "config" (subject and filter) and both paths connected or deliberately ended.
Example reply:
Done. Each new lead now gets a welcome task, and two days later a reminder if nobody has followed up.
\`\`\`operations
[{"op":"set_trigger","trigger":{"type":"contact.created"}},
 {"op":"add_step","kind":"create_task","key":"welcome","name":"Welcome the lead","config":{"title":"Welcome {{contact.full_name}}","priority":"high","assignee":"contact_owner"},"at":{"after":null}},
 {"op":"add_step","kind":"wait","key":"wait_2d","name":"Wait 2 days","config":{"mode":"duration","amount":2,"unit":"days"},"at":{"after":"welcome","via":"next"}}]
\`\`\``;
