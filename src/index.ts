import express from "express";
import crypto from "node:crypto";
import { cfg, setRuntime } from "./config.js";
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
import { autoMachine, openCapsules, verifyMachine, capsulePrice, quote } from "./capsules.js";
import { listTickets, cancelListing, fillListing, marketFor, tickMarket } from "./market.js";
import { tickPayouts, pendingPayouts, stuckPayouts } from "./payouts.js";
import { snapshotHolders } from "./holders.js";
import { halted, setHalt } from "./halt.js";
import { walletPk, solBalance, usdcBalance, walletSource } from "./wallet.js";
import { hasDas, ownsAsset, assetInfo } from "./assets.js";
import { purgeDemo } from "./purge.js";
import { createHolderRaffle } from "./raffles.js";
import fs from "node:fs";
import path from "node:path";

/**
 * KUJI — the zero-edge capsule machine.
 * Real marketplace data, real commit-reveal against real Solana blockhashes,
 * fake money. The point: prove the edges and the mechanics before launch.
 */

const app = express();
app.use(express.json());
app.use("/fonts", express.static(path.join(cfg.root, "public", "fonts"), { maxAge: "7d" }));
app.use("/img", express.static(path.join(cfg.root, "public", "img"), { maxAge: "1h" }));

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
// the live rack price — the page polls this so the sign moves in real time
app.get("/api/machine/:id/price", (req, res) => {
  const m = state.machines.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ ok: false });
  const left = m.prizes.filter((p) => !p.claimedBy);
  res.json({
    ok: true, status: m.status,
    priceUsd: capsulePrice(m), startPriceUsd: m.priceUsd,
    left: left.length, of: m.capsules,
    rackValueUsd: +left.reduce((s, p) => s + p.valueUsd, 0).toFixed(2),
    quote: quote(m, Math.max(1, Number(req.query.n) || 1)),
  });
});
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
    live: cfg.live, devnet: cfg.devnet, halted: halted(), bootstrap: cfg.bootstrap,
    das: hasDas(), rpcHost: (() => { try { return new URL(cfg.rpcUrl).host; } catch { return cfg.rpcUrl; } })(),
    tokenMint: cfg.tokenMint, xUrl: cfg.xUrl,
    vault: state.vault.filter((v) => v.status === "vault").length,
    openRaffles: state.raffles.filter((r) => r.status === "open").length,
    openMachine: state.machines.some((m) => m.status === "open"),
    wallet: walletPk.toBase58(),
    walletSource, // "env" = WALLET_SECRET (you hold a backup) | "disk" = volume only | "generated" = brand new THIS boot
    sol: await solBalance().catch(() => -1),
    usdc: await usdcBalance().catch(() => -1),
    payouts: { pending: pendingPayouts().length, stuck: stuckPayouts() },
    vaultCards: state.vault.filter((v) => v.status === "vault")
      .map((v) => ({ nft: v.nft, item: v.itemName, paid: v.paidUsd, comp: v.compUsd })),
    demoLeftovers: state.raffles.filter((r) => r.status === "open" && !r.commitSig).length
      + state.machines.filter((m) => m.status === "open" && !m.commitSig).length,
    suspectCards: state.vault.filter((v) => v.status === "vault" && (v.compUsd - v.paidUsd) / v.compUsd > cfg.maxEdge)
      .map((v) => ({ nft: v.nft, item: v.itemName, paid: v.paidUsd, comp: v.compUsd })),
  });
});
/** Accept "@kuji", "kuji", "x.com/kuji" or a full URL — store a real link.
 *  A half-typed handle would otherwise render a dead button on a live site. */
function normalizeX(input: string): string {
  const v = input.trim().replace(/^@/, "");
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(x\.com|twitter\.com)\//i.test(v)) return `https://${v}`;
  if (/^[A-Za-z0-9_]{1,15}$/.test(v)) return `https://x.com/${v}`;
  return v.startsWith("http") ? v : `https://${v}`;
}

// runtime settings: token CA, X link, and THE LIVE TOGGLE — flipping live
// starts real mainnet operation (sniper buys with real USDC) immediately
app.post("/api/admin/settings", async (req, res) => {
  if (!admin(req)) return res.status(403).json({ ok: false });
  const wasLive = cfg.live;
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.tokenMint === "string") patch.tokenMint = req.body.tokenMint.trim();
  if (typeof req.body?.xUrl === "string") patch.xUrl = normalizeX(req.body.xUrl);
  if (typeof req.body?.live === "boolean") patch.live = req.body.live;
  if (typeof req.body?.bootstrap === "boolean") patch.bootstrap = req.body.bootstrap;
  // Going live without DAS means compressed cards can be BOUGHT but never
  // verified or shipped — refuse rather than discover it on the first prize.
  if (patch.live === true && !hasDas()) {
    return res.json({
      ok: false,
      why: "no DAS RPC configured. Set RPC_URL to your Helius endpoint (it serves DAS too), or set DAS_URL. Without it, compressed cards can be bought but not delivered.",
    });
  }
  const now = setRuntime(patch);
  if (!wasLive && cfg.live) {
    // paper-mode raffles/machines/listings must never accept real money —
    // they reference cards the machine only pretended to buy
    const purged = await purgeDemo().catch((e) => { log.warn("purge", String(e).slice(0, 120)); return null; });
    if (purged) log.info("admin", `demo data cleared on go-live: ${JSON.stringify(purged)}`);
    ledger("admin-LIVE", { at: Date.now(), wallet: walletPk.toBase58(), purged });
    log.info("admin", `🔴 MACHINE IS LIVE — real ${cfg.devnet ? "devnet" : "MAINNET"} operation from now on (wallet ${walletPk.toBase58()})`);
  } else if (wasLive && cfg.live === false) {
    ledger("admin-paper", { at: Date.now() });
    log.info("admin", "machine back to PAPER mode");
  }
  res.json({ ok: true, settings: now, live: cfg.live });
});
// clear paper-mode leftovers by hand (also runs automatically on go-live)
app.post("/api/admin/purge-demo", async (req, res) => {
  if (!admin(req)) return res.status(403).json({ ok: false });
  res.json({ ok: true, purged: await purgeDemo() });
});

/**
 * Import a card the OPERATOR bought by hand into the vault.
 * Ownership is verified on-chain first: without that check the machine
 * could advertise, and then owe, a card it does not hold.
 */
app.post("/api/admin/import-card", async (req, res) => {
  if (!admin(req)) return res.status(403).json({ ok: false });
  const nft = String(req.body?.nft ?? "").trim();
  if (!nft) return res.json({ ok: false, why: "need an nft mint address" });
  if (state.vault.some((v) => v.nft === nft)) return res.json({ ok: false, why: "already in the vault" });
  let owned = false;
  try { owned = await ownsAsset(nft); } catch (e) { return res.json({ ok: false, why: `could not check ownership: ${String(e).slice(0, 90)}` }); }
  if (!owned) return res.json({ ok: false, why: "the machine wallet does not hold that card — send it to the machine wallet first" });

  const paidUsd = Number(req.body?.paidUsd) || 0;
  const compUsd = Number(req.body?.compUsd) || paidUsd;
  if (compUsd <= 0) return res.json({ ok: false, why: "need compUsd (what it is worth) — that is what tickets get priced from" });

  let itemName = String(req.body?.itemName ?? "").trim();
  let image: string | undefined;
  let kind = "";
  try {
    const info = await assetInfo(nft);
    kind = info.kind;
    const das = await fetch(cfg.dasUrl || cfg.rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: nft } }),
    }).then((r) => r.json()).catch(() => null) as any;
    itemName = itemName || String(das?.result?.content?.metadata?.name ?? "").trim();
    image = das?.result?.content?.links?.image ?? das?.result?.content?.files?.[0]?.uri;
  } catch { /* metadata is a nicety; ownership is the thing that matters */ }

  const card = {
    nft, itemName: itemName || `Card ${nft.slice(0, 6)}`, category: String(req.body?.category ?? "Pokemon"),
    grade: String(req.body?.grade ?? ""), gradingCompany: String(req.body?.gradingCompany ?? ""),
    image, paidUsd, compUsd, compBasis: "operator-supplied card (imported by hand)",
    boughtAt: Date.now(), status: "vault" as const,
  };
  state.vault.push(card);
  save();
  ledger("card-imported", { nft, item: card.itemName, paidUsd, compUsd, standard: kind });
  log.info("admin", `imported ${card.itemName.slice(0, 44)} (${kind}) — comp $${compUsd}`);
  res.json({ ok: true, card });
});

/** Run a FREE holder raffle on a specific vault card, funded by nobody. */
app.post("/api/admin/holder-raffle", async (req, res) => {
  if (!admin(req)) return res.status(403).json({ ok: false });
  const nft = String(req.body?.nft ?? "").trim();
  const card = state.vault.find((v) => v.nft === nft && v.status === "vault");
  if (!card) return res.json({ ok: false, why: "no such card sitting in the vault" });
  if (!cfg.live) return res.json({ ok: false, why: "paper mode — go live first" });
  if (!cfg.tokenMint) return res.json({ ok: false, why: "no token mint set, so there are no holders to raffle to. Set the token CA above first." });
  const holders = await snapshotHolders();
  if (!holders.length) return res.json({ ok: false, why: "the token has no holders yet (or the RPC could not read them) — a raffle with no entrants cannot resolve" });
  try {
    const r = await createHolderRaffle(card, holders, { fromPool: false });
    res.json({ ok: true, id: r.id, entrants: holders.length, entries: r.tickets });
  } catch (e) {
    res.json({ ok: false, why: String(e).slice(0, 160) });
  }
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

// Railway healthcheck — cheap, no chain calls
app.get("/health", (_req, res) => res.json({
  ok: true, mode: cfg.live ? (cfg.devnet ? "live-devnet" : "live") : "paper",
  halted: halted(), vault: state.vault.length,
  openRaffles: state.raffles.filter((r) => r.status === "open").length,
  uptimeSec: Math.round(process.uptime()),
}));

// ---------- the site ----------
mountSite(app);

// ---------- jobs ----------
// Bind 0.0.0.0 when deployed (Railway routes to the container's public
// interface — binding loopback there makes the app unreachable), 127.0.0.1
// for local dev so a laptop doesn't serve the machine to its whole network.
const deployed = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID || process.env.NODE_ENV === "production");
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
// live/paper is a RUNTIME flag (admin toggle) — gate inside each tick, not at boot
setInterval(() => { if (cfg.live) void watchPayments().catch((e) => log.warn("pay", String(e).slice(0, 100))); }, cfg.payWatchEverySec * 1000);
setInterval(() => { if (cfg.live) void tickPayouts().catch((e) => log.warn("payout", String(e).slice(0, 100))); }, 20_000);
setInterval(() => { if (!cfg.live) try { simTick(); } catch {} }, cfg.simBuyEverySec * 1000);

// Live mode with no admin key means no kill switch and no way to re-price a
// suspect card — refuse to run real money with no brakes.
if (cfg.live && !cfg.adminKey) {
  log.warn("kuji", "LIVE_MODE is on but ADMIN_KEY is unset — that leaves no halt switch. Refusing to start.");
  process.exit(1);
}

app.listen(cfg.port, process.env.HOST ?? (deployed ? "0.0.0.0" : "127.0.0.1"), () => {
  log.info("kuji", `${cfg.live ? (cfg.devnet ? "LIVE (devnet)" : "LIVE (MAINNET)") : "paper"} machine on port ${cfg.port} — wallet ${walletPk.toBase58()} (from ${walletSource}), vault ${state.vault.length} cards${halted() ? " — ⚠ HALTED" : ""}`);
  save();
});
