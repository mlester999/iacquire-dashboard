import { afterEach,describe,expect,it,vi } from "vitest";
import { checkSupabaseConfig,databaseMatchesSupabase,resolveAuthProvider } from "@/lib/supabase-config";
import { env,resetEnvCache } from "@/server/env";

afterEach(()=>{vi.unstubAllEnvs();resetEnvCache();});
describe("Supabase configuration boundaries",()=>{
  it("defaults to Supabase; local identity requires explicit selection",()=>{
    expect(resolveAuthProvider({})).toBe("supabase");
    expect(resolveAuthProvider({AUTH_PROVIDER:"local"})).toBe("local");
    expect(checkSupabaseConfig({}).map((p)=>p.code)).toEqual(["missing_url","missing_publishable_key","missing_secret_key"]);
  });
  it("rejects secrets in browser variables without returning their values",()=>{
    const secret="sb_secret_do_not_return_me";
    const issues=checkSupabaseConfig({NEXT_PUBLIC_SUPABASE_URL:"https://example.supabase.co",NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:secret,SUPABASE_SECRET_KEY:secret});
    expect(issues.some((p)=>p.code==="secret_in_public_var")).toBe(true);
    expect(JSON.stringify(issues)).not.toContain(secret);
  });
  it("binds direct and pooled database URLs to their configured project",()=>{
    const base={NEXT_PUBLIC_SUPABASE_URL:"https://portalref.supabase.co"};
    expect(databaseMatchesSupabase({...base,DATABASE_URL:"postgresql://postgres:placeholder@db.portalref.supabase.co:5432/postgres"})).toBe(true);
    expect(databaseMatchesSupabase({...base,DATABASE_URL:"postgresql://postgres.portalref:placeholder@aws-0-region.pooler.supabase.com:5432/postgres"})).toBe(true);
    for(const url of ["postgresql://postgres:placeholder@hostinger.local:5432/n8n", "postgresql://postgres.other:placeholder@aws-0-region.pooler.supabase.com:5432/postgres", "postgresql://postgres:placeholder@db.other.supabase.co:5432/postgres"]) {
      expect(databaseMatchesSupabase({...base,DATABASE_URL:url})).toBe(false);
    }
  });
  it("production rejects legacy auth even with the former escape flag",()=>{
    vi.stubEnv("NODE_ENV","production");vi.stubEnv("AUTH_PROVIDER","local");vi.stubEnv("ALLOW_LEGACY_AUTH","true");vi.stubEnv("SECRET_STORE","vault");
    resetEnvCache();expect(()=>env()).toThrow(/Production requires Supabase Auth/);
  });
  it("unconfigured production never selects an embedded database",()=>{
    vi.stubEnv("NODE_ENV","production");vi.stubEnv("AUTH_PROVIDER","supabase");vi.stubEnv("SECRET_STORE","vault");vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL","");vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY","");vi.stubEnv("SUPABASE_SECRET_KEY","");
    resetEnvCache();expect(()=>env()).toThrow(/Supabase is not fully configured/);
  });
});

describe("local configuration error when Supabase is not connected",()=>{
  it("lists the missing variable names and the docs path, never a secret value, and offers no silent fallback",async()=>{
    const React=await import("react");
    const {renderToStaticMarkup}=await import("react-dom/server");
    const {SupabaseNotConnected}=await import("@/components/auth/config-notice");
    const {supabaseConfigStatus}=await import("@/server/supabase/config");
    const leaked="sb_secret_must_never_be_rendered";
    // Placeholder-only environment: the project URL is set but nothing else is.
    const status=supabaseConfigStatus({NEXT_PUBLIC_SUPABASE_URL:"https://example.supabase.co",DATABASE_URL:"",SUPABASE_SECRET_KEY:""});
    expect(status.configured).toBe(false);
    const html=renderToStaticMarkup(React.createElement(SupabaseNotConnected,{problems:status.problems}));
    expect(html).toContain("Supabase isn&#x27;t connected yet");
    expect(html).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(html).toContain("SUPABASE_SECRET_KEY");
    expect(html).toContain("DATABASE_URL");
    expect(html).toContain("docs/supabase-setup.md");
    expect(html).toContain("Nothing has fallen back to");
    expect(html).not.toContain(leaked);
    expect(html).toContain('role="alert"');
  });
  it("does not report configured until every required value is present and consistent",async()=>{
    const {supabaseConfigStatus}=await import("@/server/supabase/config");
    const full={NEXT_PUBLIC_SUPABASE_URL:"https://portalref.supabase.co",NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:"sb_publishable_placeholder",SUPABASE_SECRET_KEY:"sb_secret_placeholder",DATABASE_URL:"postgresql://postgres:placeholder@db.portalref.supabase.co:5432/postgres",DATABASE_DRIVER:"postgres"};
    expect(supabaseConfigStatus(full).configured).toBe(true);
    expect(supabaseConfigStatus({...full,DATABASE_DRIVER:"pglite"}).configured).toBe(false);
    expect(supabaseConfigStatus({...full,DATABASE_URL:"postgresql://postgres:placeholder@hostinger.local:5432/n8n"}).configured).toBe(false);
    expect(JSON.stringify(supabaseConfigStatus(full))).not.toContain("sb_secret_placeholder");
  });
});
