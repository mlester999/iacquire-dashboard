// Compares a Vitest JSON report with the failures that already exist on production master, so the full suite can be run in CI and still fail on anything new.
// The nine files below fail identically on clean production (the first eight on `d4adb4fd`, `email-render` since the email-branding commit `a8708414`); they are unrelated to the
// Hermes bridge and are listed in docs/ai-employee-status-matrix-2026-10-29.md. A known file that now passes is reported, not failed: a fix is welcome news.
import { readFileSync } from "node:fs";

const KNOWN = new Set([
  "tests/appointments.test.ts",
  "tests/automation-studio-hardening.test.ts",
  "tests/chat-rail.test.tsx",
  "tests/demo-showroom-controls.test.tsx",
  "tests/email-render.test.ts",
  "tests/messaging-core.test.ts",
  "tests/staff-workload-views.test.ts",
  "tests/type-scale-floor.test.ts",
  "tests/workforce-navigation.test.tsx",
]);

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const relative = (name) => name.split("\\").join("/").replace(/^.*?\/(tests\/)/, "$1");
const failed = new Set(report.testResults.filter((file) => file.status === "failed").map((file) => relative(file.name)));
const unexpected = [...failed].filter((file) => !KNOWN.has(file)).sort();
const fixed = [...KNOWN].filter((file) => !failed.has(file)).sort();

console.log(`files: ${report.testResults.length}, tests passed: ${report.numPassedTests}, failed: ${report.numFailedTests}, skipped/todo: ${(report.numPendingTests ?? 0) + (report.numTodoTests ?? 0)}`);
console.log(`known failing files still failing: ${[...failed].filter((file) => KNOWN.has(file)).length} of ${KNOWN.size}`);
if (fixed.length) console.log(`known failing files that now pass (informational): ${fixed.join(", ")}`);
if (unexpected.length) {
  console.error(`UNEXPECTED failing files (${unexpected.length}):\n  ${unexpected.join("\n  ")}`);
  // Job logs need a GitHub sign-in to read, so name the failing tests and the first line of why.
  for (const file of report.testResults.filter((entry) => entry.status === "failed" && unexpected.includes(relative(entry.name)))) {
    const failedTests = (file.assertionResults ?? []).filter((test) => test.status === "failed").slice(0, 6);
    console.error(`${relative(file.name)}: ${failedTests.length ? "" : (file.message ?? "no test result (the file failed to load)").split("\n")[0].slice(0, 240)}`);
    for (const test of failedTests) {
      console.error(`  - ${test.fullName}: ${String(test.failureMessages?.[0] ?? "").split("\n")[0].slice(0, 240)}`);
    }
  }
  process.exit(1);
}
console.log("KNOWN_FAILURES_ONLY: no failure outside the nine recorded on production master");
