// Local design discovery only. No remote design calls or customer data.
import fs from "node:fs";
import path from "node:path";

const out = ".superdesign/init";
fs.mkdirSync(out, { recursive: true });
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name).replaceAll("\\", "/")]);
const dump = (f) => `## ${f}\n\n\`\`\`tsx\n${fs.readFileSync(f, "utf8")}\n\`\`\`\n`;
const primitives = walk("src/components/ui").filter((f) => /\.(tsx|ts)$/.test(f));
fs.writeFileSync(`${out}/components.md`, "# iAcquire shared primitives\n\nReact 19, Next.js 16, Tailwind 4, Radix overlays and Motion. Preserve these components.\n\n" + primitives.map(dump).join("\n"));
const layouts = [...walk("src/components/shell"), "src/components/admin/admin-shell.tsx", "src/app/layout.tsx", "src/app/(portal)/layout.tsx", "src/app/(admin)/layout.tsx"].filter((f) => fs.existsSync(f));
fs.writeFileSync(`${out}/layouts.md`, "# Shared layouts\n\n" + layouts.map(dump).join("\n"));
const routes = walk("src/app").filter((f) => f.endsWith("/page.tsx"));
const url = (f) => "/" + f.replace(/^src\/app\//, "").replace(/\/page.tsx$/, "").split("/").filter((p) => !p.startsWith("(")).join("/");
fs.writeFileSync(`${out}/routes.md`, "# Routes\n\n" + routes.map((f) => `- ${url(f)} — ${f}; inherited App Router layout\n`).join(""));
const css = fs.readFileSync("src/app/globals.css", "utf8");
const tokens = css.slice(css.indexOf(":root"), css.indexOf("@theme inline"));
fs.writeFileSync(`${out}/theme.md`, "# Design tokens\n\nGeist sans, Geist Mono, Instrument Serif display. Blue primary, violet accent, 12–30 px interface type. Rounded 12/16/24 px cards. Tailwind default breakpoints. Light/dark CSS tokens:\n\n```css\n" + tokens + "\n```\n\n# Raw globals.css\n\n```css\n" + css + "\n```\n");
const sourceFiles = new Set(walk("src"));
const resolveImport = (owner, imp) => {
  const stem = imp.startsWith("@/") ? "src/" + imp.slice(2) : imp.startsWith(".") ? path.join(path.dirname(owner), imp).replaceAll("\\", "/") : null;
  return stem && [stem, stem + ".tsx", stem + ".ts", stem + "/index.ts", stem + "/index.tsx"].find((f) => sourceFiles.has(f));
};
const trace = (owner, seen = new Set(), depth = 0) => {
  if (seen.has(owner)) return `${"  ".repeat(depth)}- ${owner} (shared)\n`;
  seen.add(owner);
  const imports = [...fs.readFileSync(owner, "utf8").matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map((m) => resolveImport(owner, m[1])).filter(Boolean);
  return `${"  ".repeat(depth)}- ${owner}\n` + [...new Set(imports)].map((f) => trace(f, seen, depth + 1)).join("");
};
const selected = routes.filter((f) => /\/(setup|overview|workforce|settings|admin|clients|integrations)(\/\[id\])?(\/setup)?\/page.tsx$/.test(f)).slice(0, 10);
fs.writeFileSync(`${out}/pages.md`, "# Important page dependencies\n\n" + selected.map((f) => `## ${url(f)}\n\n${trace(f)}\n`).join(""));
fs.writeFileSync(`${out}/extractable-components.md`, "# Shared design components\n\n" + [...primitives, ...layouts].map((f) => `## ${path.basename(f)}\n- Source: ${f}\n- Category: ${layouts.includes(f) ? "layout" : "basic"}\n- Extractable props: state, active navigation, counts, visibility\n- Hardcoded: current iAcquire branding, CSS tokens, icons and layout\n`).join("\n"));
console.log("Created six local Superdesign context files.");
