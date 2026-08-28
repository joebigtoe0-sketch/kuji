import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cfg } from "./config.js";
import { state } from "./store.js";
import { buyTickets } from "./raffles.js";
import { openCapsules } from "./capsules.js";
import { listTickets, fillListing } from "./market.js";
import { log } from "./log.js";

/**
 * The local demo crowd — paper buyers who fill raffles and a seeded holder
 * set so the whole lifecycle (fill → commit slot → draw → verify → holder
 * drop) runs with nobody watching. Off in anything resembling production.
 */

const NAMES = [
  "binder_greg", "psa10prayer", "cardboard_carl", "pullrate_penny", "vault_vibes",
  "sleeved4life", "gradeflip_gary", "misprint_mia", "topload_tony", "eternal_wotc",
];

export function seededHolders(): { wallet: string; balance: number }[] {
  const f = path.join(cfg.dataDir, "holders.json");
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    if (Array.isArray(j) && j.length) return j;
  } catch {}
  // seed a plausible distribution: a couple of whales, a crowd of smalls
  const holders = NAMES.map((n, i) => ({
    wallet: n,
    balance: i < 2 ? 5000 + Math.floor(Math.random() * 5000) : 100 + Math.floor(Math.random() * 900),
  }));
  fs.writeFileSync(f, JSON.stringify(holders, null, 1));
  log.info("sim", `seeded ${holders.length} paper holders`);
  return holders;
}

export function simTick(): void {
  if (cfg.live || !cfg.simBuyers) return; // sim NEVER runs against real money
  const open = state.raffles.filter((r) => r.kind === "paid" && r.status === "open");
  for (const r of open) {
    const soldN = r.sold.reduce((s, t) => s + t.n, 0);
    if (soldN >= r.tickets) continue;
    // buyers show up in bursts; sometimes nobody comes (tests fill-or-refund)
    if (Math.random() < 0.35) continue;
    const buyer = NAMES[Math.floor(Math.random() * NAMES.length)] + "_" + crypto.randomBytes(1).toString("hex");
    const n = Math.min(r.tickets - soldN, 1 + Math.floor(Math.random() * 3));
    const res = buyTickets(r.id, buyer, n);
    if (res.ok) log.info("sim", `${buyer} bought ${n} ticket(s) in ${r.id} (${soldN + n}/${r.tickets})`);
  }
  simCapsules();
  simMarket();
}

/** Paper crowd at the capsule machine — opens come in little bursts. */
function simCapsules(): void {
  const m = state.machines.find((x) => x.status === "open");
  if (!m || Math.random() < 0.4) return;
  const buyer = NAMES[Math.floor(Math.random() * NAMES.length)] + "_" + crypto.randomBytes(1).toString("hex");
  const n = 1 + Math.floor(Math.random() * 3);
  void openCapsules(m.id, buyer, n).then((res) => {
    if (res.ok && res.prizes)
      log.info("sim", `${buyer} opened ${res.prizes.length} capsule(s): ${res.prizes.map((p) => p.label).join(", ").slice(0, 80)}`);
  }).catch(() => {});
}

/**
 * Paper ticket market: holders relist around EV with sentiment drift —
 * sometimes under face (need liquidity), sometimes over (card pumped).
 * Buyers prefer cheap listings; overpriced ones sit, exactly like life.
 */
function simMarket(): void {
  const open = state.raffles.filter((r) => r.kind === "paid" && r.status === "open" && r.sold.length > 0);
  for (const r of open) {
    // a holder lists
    if (Math.random() < 0.35) {
      const holders = [...new Set(r.sold.map((t) => t.buyer))];
      const seller = holders[Math.floor(Math.random() * holders.length)];
      const drift = 0.75 + Math.random() * 0.75; // 0.75x..1.5x face
      const owned = r.sold.filter((t) => t.buyer === seller).reduce((s, t) => s + t.n, 0);
      if (owned > 0)
        listTickets(r.id, seller, 1 + Math.floor(Math.random() * Math.min(2, owned)), +(r.ticketUsd * drift).toFixed(2));
    }
    // a buyer scans the book, fills anything at/below ~1.15x face
    if (Math.random() < 0.5) {
      const cheap = state.market
        .filter((l) => l.raffleId === r.id && l.status === "open" && l.priceUsd <= r.ticketUsd * 1.15)
        .sort((a, b) => a.priceUsd - b.priceUsd)[0];
      if (cheap) {
        const buyer = NAMES[Math.floor(Math.random() * NAMES.length)] + "_" + crypto.randomBytes(1).toString("hex");
        fillListing(cheap.id, buyer);
      }
    }
  }
}
