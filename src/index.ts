import express from "express";
import crypto from "node:crypto";
import { cfg } from "./config.js";
import { log } from "./log.js";
import { state, save, ledgerTail, ledger } from "./store.js";
import { scan } from "./sniper.js";
import { createPaidRaffle, buyTickets, tickRaffles, tickHolderRaffles } from "./raffles.js";
import { verify } from "./draw.js";
import { mountSite } from "./site.js";
import { gradeVault } from "./grader.js";
import { autoRaffle } from "./raffles.js";
import { simTick, seededHolders } from "./sim.js";
import { buildPayTx, buildCapsulePayTx, buildMarketPayTx, watchPayments } from "./payments.js";
import { autoMachine, openCapsules, verifyMachine } from "./capsules.js";
import { listTickets, cancelListing, fillListing, marketFor, tickMarket } from "./market.js";
import { tickPayouts, pendingPayouts, stuckPayouts } from "./payouts.js";
import { snapshotHolders } from "./holders.js";
import { halted, setHalt } from "./halt.js";
import { walletPk, solBalance, usdcBalance } from "./wallet.js";
import fs from "node:fs";
import path from "node:path";

/**
 * NERDNAME — the card machine, PAPER MODE.
 * Real marketplace data, real commit-reveal against real Solana blockhashes,
 * fake money. The point: prove the edges and the mechanics before launch.
 */

const app = express();
app.use(express.json());
app.use("/fonts", express.static(path.join(cfg.root, "public", "fonts"), { maxAge: "7d" }));

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

// live payments: the buy widgets ask for an unsigned tx to hand Phantom.
// kind=raffle (default) | capsule | market
app.get("/api/paytx", async (req, res) => {
  if (!cfg.live) return res.json({ ok: false, why: "paper mode — purchases are simulated" });
  if (halted()) return res.json({ ok: false, why: "machine is paused" });
  const payer = String(req.query.payer ?? "");
  const n = Math.max(1, Number(req.query.n) || 1);
  const currency = req.query.currency === "ansem" ? "ansem" as const : "usdc" as const;
  try {
    const out = req.query.kind === "capsule"
      ? await buildCapsulePayTx(String(req.query.machine ?? ""), n, payer, currency)
      : req.query.kind === "market"
        ? await buildMarketPayTx(String(req.query.listing ?? ""), payer)
        : await buildPayTx(String(req.query.raffle ?? ""), n, payer, currency);
    res.json(out);
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 120) });
  }
});

// paper-mode interactions (the sim uses these paths too)
app.post("/api/machine/:id/open", async (req, res) => {
  if (cfg.live) return res.json({ ok: false, why: "live mode opens via /api/paytx?kind=capsule" });
  const buyer = String(req.body?.buyer ?? ("anon-" + crypto.randomBytes(3).toString("hex")));
  res.json(await openCapsules(req.params.id, buyer, Math.max(1, Number(req.body?.n) || 1)));
});
app.get("/api/verify-machine/:id", (req, res) => res.json(verifyMachine(req.params.id)));
app.post("/api/market/list", (req, res) => {
  res.json(listTickets(String(req.body?.raffle ?? ""), String(req.body?.seller ?? ""), Number(req.body?.n) || 0, Number(req.body?.price) || 0));
});
app.post("/api/market/:id/cancel", (req, res) => res.json(cancelListing(req.params.id, String(req.body?.seller ?? ""))));
app.post("/api/market/:id/buy", (req, res) => {
  if (cfg.live) return res.json({ ok: false, why: "live mode fills via /api/paytx?kind=market" });
  res.json(fillListing(req.params.id, String(req.body?.buyer ?? ("anon-" + crypto.randomBytes(3).toString("hex")))));
});
app.get("/api/market/:raffleId", (req, res) => res.json(marketFor(req.params.raffleId)));

// ---------- admin (live ops) ----------
const admin = (req: express.Request): boolean =>
  !!cfg.adminKey && req.headers["x-admin-key"] === cfg.adminKey;
app.post("/api/admin/halt", (req, res) => {
  if (!admin(req)) return res.status(403).json({ ok: false });
  setHalt(req.body?.on !== false, String(req.body?.why ?? "manual"));
  res.json({ ok: true, halted: halted() });
});
app.get("/api/admin/status", async (req, res) => {
  if (!admin(req)) return res.status(403).json({ ok: false });
  res.json({
    live: cfg.live, devnet: cfg.devnet, halted: halted(),
    wallet: walletPk.toBase58(),
    sol: await solBalance().catch(() => -1),
    usdc: await usdcBalance().catch(() => -1),
    payouts: { pending: pendingPayouts().length, stuck: stuckPayouts() },
    suspectCards: state.vault.filter((v) => v.status === "vault" && (v.compUsd - v.paidUsd) / v.compUsd > cfg.maxEdge)
      .map((v) => ({ nft: v.nft, item: v.itemName, paid: v.paidUsd, comp: v.compUsd })),
  });
});
// re-price a suspect card after human review (unblocks it for raffling)
app.post("/api/admin/reprice", (req, res) => {
  if (!admin(req)) return res.status(403).json({ ok: false });
  const card = state.vault.find((v) => v.nft === String(req.body?.nft ?? ""));
  const comp = Number(req.body?.compUsd);
  if (!card || !Number.isFinite(comp) || comp <= 0) return res.json({ ok: false, why: "need nft + compUsd" });
  ledger("admin-reprice", { nft: card.nft, item: card.itemName, from: card.compUsd, to: comp });
  card.compBasis = `admin re-priced (machine's comp was $${card.compUsd})`;
  card.compUsd = comp;
  save();
  res.json({ ok: true });
});

// the verify page — the whole point of the commitment scheme
app.get("/api/verify/:id", (req, res) => {
  const r = state.raffles.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ ok: false, why: "no such raffle" });
  if (r.status !== "resolved" || !r.seed || !r.blockhash)
    return res.json({ ok: false, why: "not resolved yet", status: r.status, commitHash: r.commitHash, resolveSlot: r.resolveSlot });
  const owners: string[] = [];
  for (const t of r.sold) for (let i = 0; i < t.n; i++) owners.push(t.buyer);
  const winnerIndex = r.winnerIndex ?? -1;
  // recompute from published data only
  const manifest = r.kind === "paid"
    ? JSON.stringify({ id: r.id, nft: r.nft, item: r.title, tickets: r.tickets, ticketUsd: r.ticketUsd, rule: "resolves only if sold out by deadline; else refund" })
    : null;
  const check = manifest
    ? verify({ manifestJson: manifest, seed: r.seed, resolveSlot: r.resolveSlot, commitHash: r.commitHash, blockhash: r.blockhash, total: owners.length, claimedWinnerIndex: winnerIndex })
    : { ok: true, why: "holder manifest embeds full snapshot — see ledger" };
  res.json({ raffle: r.id, status: r.status, commitHash: r.commitHash, seed: r.seed, resolveSlot: r.resolveSlot, blockhash: r.blockhash, winner: r.winner, verified: check });
});

// ---------- the site ----------
mountSite(app);

// ---------- jobs ----------
setInterval(() => void scan().catch((e) => log.warn("sniper", String(e).slice(0, 100))), cfg.scanEveryMin * 60_000);
setTimeout(() => void scan().catch((e) => log.warn("sniper", String(e).slice(0, 100))), 3000);
setInterval(() => void tickRaffles().catch(() => {}), 30_000);
setInterval(() => {
  // live: real holder snapshot from the launched mint; paper: simulated set
  const src = cfg.live ? snapshotHolders() : Promise.resolve(holders.length ? holders : seededHolders());
  void src.then((h) => tickHolderRaffles(h)).catch(() => {});
}, 60_000);
setInterval(() => void gradeVault().catch(() => {}), 5 * 60_000);
setInterval(() => void autoRaffle().catch((e) => log.warn("raffle", String(e).slice(0, 80))), 45_000);
setInterval(() => void autoMachine().catch((e) => log.warn("capsule", String(e).slice(0, 80))), 50_000);
setInterval(() => { try { tickMarket(); } catch {} }, 30_000);
if (cfg.live) {
  setInterval(() => void watchPayments().catch((e) => log.warn("pay", String(e).slice(0, 100))), cfg.payWatchEverySec * 1000);
  setInterval(() => void tickPayouts().catch((e) => log.warn("payout", String(e).slice(0, 100))), 20_000);
} else {
  setInterval(() => { try { simTick(); } catch {} }, cfg.simBuyEverySec * 1000);
}

app.listen(cfg.port, cfg.live ? "0.0.0.0" : "127.0.0.1", () => {
  log.info("nerd", `${cfg.live ? (cfg.devnet ? "LIVE (devnet)" : "LIVE (MAINNET)") : "paper"} machine on port ${cfg.port} — wallet ${walletPk.toBase58()}, vault ${state.vault.length} cards${halted() ? " — ⚠ HALTED" : ""}`);
  save();
});
