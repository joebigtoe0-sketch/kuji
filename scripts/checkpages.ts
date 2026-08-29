import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { mountSite } from "../src/site.js";

/**
 * Render every page and parse its inline <script> blocks.
 *
 * Pages are built from template literals, so a `\n` written inside one is
 * expanded at BUILD time and reaches the browser as a real line break in
 * the middle of a JS string. That is a SyntaxError, and one SyntaxError
 * kills the entire script — every handler on the page silently stops
 * working while the server still returns 200. It has bitten twice: the
 * admin panel's unlock button, then its giveaway button.
 *
 * Neither typecheck nor an HTTP 200 catches it. This does.
 */

const app = express();
mountSite(app);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = (server.address() as { port: number }).port;

const PAGES = ["/", "/raffles", "/vault", "/grades", "/feed", "/admin"];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kuji-pages-"));
let bad = 0;

for (const page of PAGES) {
  const html = await fetch(`http://127.0.0.1:${port}${page}`).then((r) => r.text());
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const broken: string[] = [];
  scripts.forEach((body, i) => {
    if (!body.trim()) return;
    const f = path.join(tmp, `p${i}.js`);
    fs.writeFileSync(f, body);
    const res = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (res.status !== 0) broken.push((res.stderr.split("\n").find((l) => l.includes("Error")) ?? "syntax error").trim());
  });
  if (broken.length) {
    bad++;
    console.error(`  ${page}  BROKEN: ${broken.join(" | ")}`);
  } else {
    console.log(`  ${page}  ok (${scripts.length} script${scripts.length === 1 ? "" : "s"})`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
server.close();

if (bad) {
  console.error(`\n${bad} page(s) ship broken JavaScript. Most likely a \\n inside a template literal: escape it as \\\\n.\n`);
  process.exit(1);
}
console.log(`pages ok — every inline script on ${PAGES.length} pages parses`);
process.exit(0);
