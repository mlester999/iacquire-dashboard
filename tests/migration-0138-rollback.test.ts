import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createOrg, createUser } from "./support/fixtures";

const DOWN = readFileSync("supabase/rollbacks/0138_growth_partner_chat_task_preview.down.sql", "utf8");
const GUARD = DOWN.match(/do \$\$[\s\S]*?\$\$;/i)?.[0];

describe("migration 0138 rollback data guard", () => {
  it("refuses to remove saved task previews", async () => {
    if (!GUARD) throw new Error("0138 rollback guard block is missing");
    const org = await createOrg({ name: "0138 rollback guard" });
    const user = await createUser();
    const agents = await withSystem((db) => db.query<{ id: string }>(
      "select id from agent_instances where org_id = $1 order by role_key limit 1",
      [org.id],
    ));
    const agentInstanceId = agents.rows[0]?.id;
    if (!agentInstanceId) throw new Error("The rollback guard fixture needs one conversation profile");

    await expect(withSystem(async (db) => {
      await db.query(
        `insert into chat_conversations (org_id, agent_instance_id, user_id, hermes_session_id, pending_workforce_task)
         values ($1, $2, $3, $4, '{"title":"Follow up with the lead"}'::jsonb)`,
        [org.id, agentInstanceId, user.id, `0138-rollback-${org.id}`],
      );
      await db.query(GUARD);
    })).rejects.toThrow(/saved Growth Partner task previews exist/);
  });
});
