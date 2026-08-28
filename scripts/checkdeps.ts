import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fail if the code imports a package that is not declared in package.json.
 *
 * Locally everything resolves, because transitive dependencies sit in a
 * flat node_modules — so importing something a dependency happens to pull
 * in works fine on this machine and then crash-loops on a fresh
 * `npm ci --omit=dev` in production. That is exactly how tweetnacl took
 * the deploy down. Typechecking does not catch it; the types resolve too.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

const files: string[] = [];
for (const dir of ["src", "scripts"]) {
  const d = path.join(root, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) if (f.endsWith(".ts")) files.push(path.join(d, f));
}

// Only real module statements. site.ts embeds a lot of browser JS inside
// template literals, and a loose regex happily "finds" imports in there.
const PATTERNS = [
  /^[ \t]*import[ \t]+[^;\r\n]*?from[ \t]*["']([^"']+)["']/gm,
  /^[ \t]*import[ \t]*["']([^"']+)["']/gm,
  /^[ \t]*export[ \t]+[^;\r\n]*?from[ \t]*["']([^"']+)["']/gm,
  /\bawait[ \t]+import[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g,
];

const missing = new Map<string, Set<string>>();
for (const f of files) {
  const body = fs.readFileSync(f, "utf8");
  for (const re of PATTERNS) {
    for (const m of body.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (declared.has(base)) continue;
      const where = missing.get(base) ?? new Set<string>();
      where.add(path.basename(f));
      missing.set(base, where);
    }
  }
}

if (missing.size) {
  console.error("\nUNDECLARED IMPORTS — these resolve locally but will crash a clean install:\n");
  for (const [base, where] of missing) console.error(`  ${base}   (imported by ${[...where].join(", ")})`);
  console.error(`\nFix: npm install --save ${[...missing.keys()].join(" ")}\n`);
  process.exit(1);
}
console.log(`deps ok — ${files.length} files scanned, every import declared`);
