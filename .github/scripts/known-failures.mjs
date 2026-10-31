// Compares a Vitest JSON report with the failures that already exist on production master, so the full suite can be run in CI and still fail on anything new.
// A known file that now passes is reported, not failed: a fix is welcome news. The nine that were recorded here until 2026-10-31 are listed in docs/ai-employee-status-matrix-2026-10-29.md.
import { readFileSync } from "node:fs";

// Empty on purpose: the nine files that failed on production master were stale tests (fixed dates, a month boundary, a weekday, a renamed wordmark, a moved rail width, a new email
// mark) and the 12px text floor, all fixed. A failure that cannot be fixed at once is recorded here again, as a repository-relative path with the reason in a comment.
const KNOWN = new Set([]);

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
console.log(KNOWN.size === 0 ? "NO_FAILURES: every test file passes" : `KNOWN_FAILURES_ONLY: no failure outside the ${KNOWN.size} recorded`);
