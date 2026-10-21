// A production build that answers for the code alone, and cannot reach anything hosted.
//  - It writes to its own output folder (.next-clean-build, which tsconfig.clean.json knows about) and type-checks with tsconfig.clean.json, so
//    the generated type folders of other builds on this machine (a QA run from before a route moved, say) cannot fail it.
//  - Next.js reads .env for every key that is not already set, and this repository's .env names the hosted project. The keys below are set (to
//    blank, or to the embedded database) so the build never loads those values: nothing is contacted and no secret ends up in the bundle.
//    The output is for checking the code, not for deploying.
// It does not touch .next or any other build output, and it is the same compile `npm run build` does.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync(".next-clean-build", { recursive: true, force: true });
const pins = {
  IAQ_DIST_DIR: ".next-clean-build",
  IAQ_TSCONFIG: "tsconfig.clean.json",
  NEXT_TELEMETRY_DISABLED: "1",
  AUTH_PROVIDER: "local",
  DATABASE_DRIVER: "pglite-memory",
  DATABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_URL: "",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
  SUPABASE_SECRET_KEY: "",
  RESEND_API_KEY: "",
  LLM_API_KEY: "",
  LLM_BASE_URL: "",
  N8N_API_KEY: "",
  N8N_BASE_URL: "",
  SLACK_SUPPORT_WEBHOOK_URL: "",
  GHL_API_BASE: "",
  GHL_WRITES_ENABLED: "false",
  EMAIL_PROVIDER: "capture",
};
const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ...pins } });
process.exit(result.status ?? 1);
