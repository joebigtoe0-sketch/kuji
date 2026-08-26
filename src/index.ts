import express from "express";
import crypto from "node:crypto";
import { cfg } from "./config.js";
import { log } from "./log.js";
import { state, save, ledgerTail, ledger } from "./store.js";
import { scan } from "./sniper.js";
import { createPaidRaffle, buyTickets, tickRaffles, tickHolderRaffles } from "./raffles.js";
import { verify } from "./draw.js";
import fs from "node:fs";
import path from "node:path";

/**
 * NERDNAME — the card machine, PAPER MODE.
 * Real marketplace data, real commit-reveal against real Solana blockhashes,
 * fake money. The point: prove the edges and the mechanics before launch.
 */

const app = express();
app.use(express.json());

// ---------- paper holder registry (simulates token holders) ----------
interface Holder { wallet: string; balance: number }
const HOLDERS_FILE = path.join(cfg.dataDir, "holders.json");
let holders: Holder[] = (() => {
  try { return JSON.parse(fs.readFileSync(HOLDERS_FILE, "utf8")); } catch { return []; }
})();
function saveHolders(): void { fs.writeFileSync(HOLDERS_FILE, JSON.stringify(holders, null, 1)); }

// ---------- api ----------
app.get("/api/state", (_req, res) => {
  const vaultValue = state.vault.filter((v) => v.status !== "awarded" && v.status !== "holder_prize")
    .reduce((s, v) => s + v.compUsd, 0);
  const vaultCost = state.vault.filter((v) => v.status !== "awarded" && v.status !== "holder_prize")
    .reduce((s, v) => s + v.paidUsd, 0);
  res.json({
    paper: true,
    walletUsd: +state.walletUsd.toFixed(2),
    holderPoolUsd: +state.holderPoolUsd.toFixed(2),
    realizedProfitUsd: +state.realizedProfitUsd.toFixed(2),
    vault: { cards: state.vault.length, costUsd: +vaultCost.toFixed(2), compUsd: +vaultValue.toFixed(2) },
    raffles: state.raffles.map((r) => ({
      id: r.id, kind: r.kind, title: r.title, status: r.status,
      tickets: r.tickets, ticketUsd: r.ticketUsd,
      sold: r.sold.reduce((s, t) => s + t.n, 0),
      commitHash: r.commitHash, resolveSlot: r.resolveSlot,
      winner: r.winner ?? null,
    })),
    holders: holders.length,
  });
});
app.get("/api/vault", (_req, res) => res.json(state.vault));
app.get("/api/ledger", (_req, res) => res.json(ledgerTail(200)));

// paper actions (the "users" of the paper era are us + the sim)
app.post("/api/raffle/from-vault", async (req, res) => {
  const nft = String(req.body?.nft ?? "");
  const card = state.vault.find((v) => v.nft === nft && v.status === "vault");
  if (!card) return res.json({ ok: false, why: "no such vault card" });
  const r = await createPaidRaffle(card);
  res.json({ ok: true, id: r.id, tickets: r.tickets, ticketUsd: r.ticketUsd, commit: r.commitHash });
});
app.post("/api/raffle/:id/buy", (req, res) => {
  const buyer = String(req.body?.buyer ?? ("anon-" + crypto.randomBytes(3).toString("hex")));
  const n = Math.max(1, Number(req.body?.n) || 1);
  res.json(buyTickets(req.params.id, buyer, n));
});
app.post("/api/holders", (req, res) => {
  // paper: set the simulated holder list [{wallet,balance}]
  if (Array.isArray(req.body)) {
    holders = req.body
      .filter((h: any) => h?.wallet && Number(h?.balance) > 0)
      .map((h: any) => ({ wallet: String(h.wallet), balance: Number(h.balance) }));
    saveHolders();
    ledger("holders-set", { count: holders.length });
    return res.json({ ok: true, count: holders.length });
  }
  res.json({ ok: false, why: "body must be an array of {wallet,balance}" });
});

// the verify page — the whole point of the commitment scheme
app.get("/api/verify/:id", (req, res) => {
  const r = state.raffles.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ ok: false, why: "no such raffle" });
  if (r.status !== "resolved" || !r.seed || !r.blockhash)
    return res.json({ ok: false, why: "not resolved yet", status: r.status, commitHash: r.commitHash, resolveSlot: r.resolveSlot });
  const owners: string[] = [];
  for (const t of r.sold) for (let i = 0; i < t.n; i++) owners.push(t.buyer);
  const winnerIndex = owners.findIndex((w, i) => w === r.winner && owners.slice(0, i).filter((x) => x === r.winner).length === 0);
  // recompute from published data only
  const manifest = r.kind === "paid"
    ? JSON.stringify({ id: r.id, nft: r.nft, item: r.title, tickets: r.tickets, ticketUsd: r.ticketUsd, rule: "resolves only if sold out by deadline; else refund" })
    : null;
  const check = manifest
    ? verify({ manifestJson: manifest, seed: r.seed, resolveSlot: r.resolveSlot, commitHash: r.commitHash, blockhash: r.blockhash, total: owners.length, claimedWinnerIndex: winnerIndex })
    : { ok: true, why: "holder manifest embeds full snapshot — see ledger" };
  res.json({ raffle: r.id, status: r.status, commitHash: r.commitHash, seed: r.seed, resolveSlot: r.resolveSlot, blockhash: r.blockhash, winner: r.winner, verified: check });
});

// ---------- minimal nerd terminal ----------
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>NERDNAME — paper mode</title>
<style>body{background:#0a0e0a;color:#9ef01a;font:14px/1.5 ui-monospace,monospace;max-width:900px;margin:24px auto;padding:0 12px}
a{color:#38b000}h1{font-size:18px}pre{background:#101510;padding:12px;border:1px solid #1c2b1c;overflow-x:auto}
.dim{color:#5a7a4a}</style>
<h1>NERDNAME <span class="dim">// the card machine — PAPER MODE, nothing is real except the math</span></h1>
<pre id="s">loading…</pre>
<p class="dim">endpoints: /api/state · /api/vault · /api/ledger · /api/verify/:id</p>
<script>
const load=async()=>{document.getElementById('s').textContent=JSON.stringify(await (await fetch('/api/state')).json(),null,2)};
load();setInterval(load,10000);
</script>`);
});

// ---------- jobs ----------
setInterval(() => void scan().catch((e) => log.warn("sniper", String(e).slice(0, 100))), cfg.scanEveryMin * 60_000);
setTimeout(() => void scan().catch((e) => log.warn("sniper", String(e).slice(0, 100))), 3000);
setInterval(() => void tickRaffles().catch(() => {}), 30_000);
setInterval(() => void tickHolderRaffles(holders).catch(() => {}), 60_000);

app.listen(cfg.port, "127.0.0.1", () => {
  log.info("nerd", `paper machine on http://127.0.0.1:${cfg.port} — budget $${state.walletUsd.toFixed(2)}, vault ${state.vault.length} cards`);
  save();
});
