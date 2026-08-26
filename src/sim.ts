import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cfg } from "./config.js";
import { state } from "./store.js";
import { buyTickets } from "./raffles.js";
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
  if (!cfg.simBuyers) return;
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
}
