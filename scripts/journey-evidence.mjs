// Counts, for each of the eight business journeys, how many tests in its files speak to each failure and safety category, by what the test TITLES say. It measures presence, not
// quality: a count of zero is a real gap to look at, a high count is not proof. Run: node scripts/journey-evidence.mjs [--md]
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tests = fs.readdirSync(path.join(root, "tests")).filter((f) => /\.test\.tsx?$/.test(f));

const JOURNEYS = {
  "1 Purchase to operational client": /^(purchase|payment-gate|billing-(clearance|manual|providers|reported|ui)|client-onboarding|client-provisioning|onboarding|setup-|offboarding|six-employees)/,
  "2 Lead acquisition": /^(lead|leads|webchat|web-chat|attribution|lead-sources|crm-forms|crm-contacts|phase2-lead|public-lead|growth|contact-capture)/,
  "3 Missed-call recovery": /^(missed-call|calls|call-|voice|phase2-(missed|automation)|appointments-reminder)/,
  "4 Automation Studio": /^(automation-studio|crm-workflow|workflow|crm-automation)/,
  "5 Social acquisition": /^(social|lead-touch|attribution)/,
  "6 Sales closing": /^(proposal|esign|invoice|invoices|customer-payment|pay-|reputation-(survey|batch)|sales|pipeline)/,
  "7 Support and client operations": /^(support|requests|phase6|project|custom-project|maintenance-request|staff-(messages|workload)|change-request)/,
  "8 Subscription lifecycle": /^(maintenance|billing-lifecycle|billing-plan|entitlements|automation-studio-plan|renewal|plan-)/,
};

const CATEGORIES = {
  "happy path": /\b(creates?|records?|completes?|sends?|saves?|shows?|opens?|runs?|issues?|accepts?|pays?|provisions?|publishes?|books?|returns?|lists?|reads?|renews?)\b/i,
  "invalid input": /\b(invalid|rejects?|refuses? (a |an )?(bad|empty|malformed|wrong|short)|malformed|validat|too (long|short|many)|not a valid|empty|missing)\b/i,
  "unauthorized": /\b(unauthori[sz]ed|forbidden|not allowed|only (an? )?(owner|admin|super admin|manager|agency)|permission|role|viewer|cannot|can't|refus)/i,
  "cross-tenant": /\b(other workspace|another workspace|cross[- ]tenant|tenant|other (client|org)|another (client|org)|isolat|never (sees?|reads?) (another|other))/i,
  "duplicate / replay": /\b(duplicate|twice|replay|idempoten|repeat|again|already|once\b|dedupe|retry (is|does))/i,
  "provider failure": /\b(provider (fail|error|down|refus)|fails? (safely|whole)|unavailable|timeout|times? out|outage|could not|unreachable|declin|rejected by)\b/i,
  "interruption / recovery": /\b(recover|resum|interrupt|crash|restart|stale|retr(y|ies)|sweep|lease|resilien|rollback|rolled back)/i,
  "audit": /\b(audit|timeline|recorded|logged|history|trail)\b/i,
};

function titles(file) {
  const text = fs.readFileSync(path.join(root, "tests", file), "utf8");
  return [...text.matchAll(/^\s*(?:it|test)(?:\.each\([^)]*\))?\(\s*([`'"])((?:\\.|(?!\1).)*)\1/gm)].map((m) => m[2]);
}

const rows = [];
for (const [name, pattern] of Object.entries(JOURNEYS)) {
  const files = tests.filter((f) => pattern.test(f));
  const all = files.flatMap((f) => titles(f));
  const counts = Object.fromEntries(Object.entries(CATEGORIES).map(([c, re]) => [c, all.filter((t) => re.test(t)).length]));
  rows.push({ name, files: files.length, tests: all.length, counts });
}

const md = process.argv.includes("--md");
if (md) {
  console.log(`| Journey | Files | Tests | ${Object.keys(CATEGORIES).join(" | ")} |`);
  console.log(`| --- | ---: | ---: | ${Object.keys(CATEGORIES).map(() => "---:").join(" | ")} |`);
  for (const r of rows) console.log(`| ${r.name} | ${r.files} | ${r.tests} | ${Object.values(r.counts).join(" | ")} |`);
} else {
  for (const r of rows) {
    console.log(`${r.name}: ${r.files} files, ${r.tests} tests`);
    console.log("  " + Object.entries(r.counts).map(([c, n]) => `${c} ${n}`).join(", "));
  }
}
