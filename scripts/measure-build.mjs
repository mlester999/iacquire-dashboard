// Measures a build: how long it ran, how it ended, and the PEAK memory (working set) of the build's whole process tree, sampled every few seconds. Development tool; reads no secret
// and reaches nothing. It exists so "the webpack build runs out of memory" is a measurement with a number on it and not a feeling.
//   node scripts/measure-build.mjs --label turbopack-default -- node scripts/build-clean.mjs
//   node scripts/measure-build.mjs --label webpack-8gb --heap 8192 -- node scripts/build-clean.mjs --webpack
// --heap N sets NODE_OPTIONS=--max-old-space-size=N for the build. --interval S is the sampling period in seconds (default 3). Appends one JSON line to --out
// (default .data/build-measurements.jsonl) and prints it. The tree is found by parent process id on Windows (PowerShell + CIM) and with `ps` elsewhere.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
if (dash < 0) throw new Error("usage: measure-build.mjs [--label x] [--heap MB] [--interval S] [--out file] -- command args");
const opts = argv.slice(0, dash);
const cmd = argv.slice(dash + 1);
const opt = (name, fallback) => (opts.includes(name) ? opts[opts.indexOf(name) + 1] : fallback);
const label = opt("--label", cmd.join(" ").slice(0, 60));
const heap = opt("--heap", null);
const interval = Math.max(1, Number(opt("--interval", "3"))) * 1000;
const out = opt("--out", ".data/build-measurements.jsonl");

function treeMemoryMb(rootPid) {
  try {
    if (process.platform === "win32") {
      const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize; $ids = @(${rootPid}); $seen = @{}; $sum = 0; $count = 0;
        while ($ids.Count -gt 0) { $next = @(); foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not $seen.ContainsKey($p.ProcessId)) { $seen[$p.ProcessId] = 1; $next += $p.ProcessId; $sum += $p.WorkingSetSize; $count++ } } $ids = $next }
        "$([math]::Round($sum / 1MB)) $count"`;
      const text = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 20000 }).trim();
      const [mb, count] = text.split(/\s+/).map(Number);
      return { mb: mb || 0, processes: count || 0 };
    }
    const text = execFileSync("ps", ["-eo", "pid,ppid,rss"], { encoding: "utf8" });
    const rows = text.trim().split("\n").slice(1).map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Set([rootPid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, ppid] of rows) if (kids.has(ppid) && !kids.has(pid)) { kids.add(pid); grew = true; }
    }
    const sum = rows.filter(([pid]) => kids.has(pid) && pid !== rootPid).reduce((t, r) => t + r[2], 0);
    return { mb: Math.round(sum / 1024), processes: kids.size - 1 };
  } catch {
    return { mb: 0, processes: 0 };
  }
}

const env = { ...process.env };
if (heap) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --max-old-space-size=${heap}`.trim();
const started = Date.now();
const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"], env });
let tail = "";
const keep = (d) => {
  tail = (tail + d.toString()).slice(-6000);
};
child.stdout.on("data", keep);
child.stderr.on("data", keep);
let peak = { mb: 0, processes: 0, atSeconds: 0 };
let samples = 0;
const timer = setInterval(() => {
  const m = treeMemoryMb(child.pid);
  samples += 1;
  if (m.mb > peak.mb) peak = { mb: m.mb, processes: m.processes, atSeconds: Math.round((Date.now() - started) / 1000) };
}, interval);

const code = await new Promise((resolve) => child.on("exit", (c, s) => resolve(c ?? (s ? 128 : 1))));
clearInterval(timer);
const lastLines = tail.split("\n").filter(Boolean).slice(-6).map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 200));
const oom = /heap out of memory|JavaScript heap|Allocation failed|FATAL ERROR|out of memory/i.test(tail);
const line = {
  label, command: cmd.join(" "), heapMb: heap ? Number(heap) : null, exitCode: code, outcome: code === 0 ? "passed" : oom ? "out_of_memory" : "failed",
  seconds: Math.round((Date.now() - started) / 1000), peakTreeMemoryMb: peak.mb, peakProcesses: peak.processes, peakAtSeconds: peak.atSeconds, samples,
  node: process.version, platform: process.platform, at: new Date().toISOString(), lastLines,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.appendFileSync(out, JSON.stringify(line) + "\n");
console.log(JSON.stringify(line, null, 2));
process.exit(code === 0 ? 0 : 1);
