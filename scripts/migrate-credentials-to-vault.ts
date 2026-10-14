/** Explicit migration tool. Default is counts-only dry run; no external CRM/Hermes/n8n calls. */
import { withSystem,closeDb } from "../src/server/db/index";
import { env } from "../src/server/env";
import { saveCredential,credentialStoreReady } from "../src/server/security/credentials";
import { decryptSecret } from "../src/server/security/crypto";
import { supabaseConfigStatus } from "../src/server/supabase/config";

const args=process.argv.slice(2);
const apply=args.includes("--apply");const index=args.indexOf("--confirm-project");const project=index>=0?args[index+1]:null;
try {
  const config=env();
  if(config.DATABASE_DRIVER!=="postgres" || config.AUTH_PROVIDER!=="supabase")throw new Error("Use the approved Supabase project connection; this migration does not run against embedded data.");
  if(apply && (!project || project!==supabaseConfigStatus().projectRef))throw new Error("Apply requires --confirm-project matching the configured Supabase project reference.");
  const summary=await withSystem(async db=>{
    const {rows}=await db.query<{provider:string;n:number}>("select provider,count(*)::int as n from integration_credentials where credential_reference_id is null and revoked_at is null group by provider");
    return rows;
  });
  console.log("Legacy active credential counts:",JSON.stringify(summary));
  if(!apply)console.log("Dry run only. Back up source data and encryption key, verify the approved target, then run --apply --confirm-project <project-ref>.");
  else {
    if(!config.APP_ENCRYPTION_KEY || config.APP_ENCRYPTION_KEY.length<32)throw new Error("Configure the original APP_ENCRYPTION_KEY in secure server settings before migration.");
    await withSystem(async db=>{
      if(!await credentialStoreReady(db))throw new Error("Managed Supabase Vault is unavailable.");
      const actors=await db.query<{id:string}>("select id from users where status='active' and platform_role='agency_super_admin' order by created_at limit 1");
      if(!actors.rows[0])throw new Error("A migrated active agency super-admin profile is required.");
      const {rows}=await db.query<{id:string;org_id:string|null;provider:string;label:string;ciphertext:string;scopes:string[]}>("select id,org_id,provider,label,ciphertext,scopes from integration_credentials where credential_reference_id is null and revoked_at is null for update");
      for(const r of rows) {
        if(!["hermes","ghl","n8n"].includes(r.provider))throw new Error("A legacy provider needs a reviewed migration adapter. No changes were committed.");
        let plaintext:string;
        try{plaintext=decryptSecret(r.ciphertext);}catch{throw new Error("A legacy credential could not be decrypted. Check the original key; no changes were committed.");}
        const next=await saveCredential(db,{orgId:r.org_id,provider:r.provider as "hermes"|"ghl"|"n8n",label:r.label,secret:plaintext,scopes:r.scopes,actorId:actors.rows[0].id,replaces:r.id});
        await db.query("update agent_instances set credential_id=$2,status='provisioning',last_health_ok=null,last_health_check_at=null where credential_id=$1",[r.id,next.id]);
        await db.query("update ghl_location_mappings set credential_id=$2,status='pending',verified_at=null where credential_id=$1",[r.id,next.id]);
        await db.query("update integration_connections set credential_id=$2,status='credentials_saved',capabilities='{}',revision=revision+1 where credential_id=$1",[r.id,next.id]);
      }
      console.log(`Managed references prepared for ${rows.length} credentials; all legacy ciphertext retained and active mappings require new verification.`);
    });
  }
}catch{console.error("Credential migration stopped. Verify project authorization, managed Vault, active super-admin profile and original encryption key. No secret values are logged.");process.exitCode=1;}
finally{await closeDb();}
