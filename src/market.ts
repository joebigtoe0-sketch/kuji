import crypto from "node:crypto";
import { cfg } from "./config.js";
import { state, save, ledger, type TicketListing } from "./store.js";
import { queuePayout } from "./payouts.js";
import { log } from "./log.js";

/**
 * The ticket market — fractions stay TRADABLE until the draw. This is the
 * founder's "fractionalize and tradable up until the entire product gets
 * claimed" sentence, implemented:
 *
 * - a ticket holder lists any number of their tickets at any price
 * - a buyer pays; tickets reassign; in live mode the proceeds go to the
 *   seller via the payout queue (machine wallet is the escrow leg)
 * - the market closes the moment the raffle leaves "open"
 * - a live ticket price is a live price on the CARD: ticket x N = what the
 *   market thinks the card is worth. The gacha becomes a price feed.
 *
 * Ownership snapshots for the draw always come from r.sold at resolve
 * time, so trades before the draw simply move the entries.
 */

function ticketsOf(raffleId: string, wallet: string): number {
  const r = state.raffles.find((x) => x.id === raffleId);
  if (!r) return 0;
  const owned = r.sold.filter((t) => t.buyer === wallet).reduce((s, t) => s + t.n, 0);
  const listed = state.market
    .filter((l) => l.raffleId === raffleId && l.seller === wallet && l.status === "open")
    .reduce((s, l) => s + l.n, 0);
  return owned - listed; // can't list what's already listed
}

export function listTickets(raffleId: string, seller: string, n: number, priceUsd: number): { ok: boolean; id?: string; why?: string } {
  const r = state.raffles.find((x) => x.id === raffleId);
  if (!r || r.status !== "open" || r.kind !== "paid") return { ok: false, why: "market is closed for this raffle" };
  if (n < 1 || !Number.isFinite(priceUsd) || priceUsd <= 0) return { ok: false, why: "bad n/price" };
  if (ticketsOf(raffleId, seller) < n) return { ok: false, why: "not enough unlisted tickets" };
  const l: TicketListing = {
    id: crypto.randomBytes(5).toString("hex"), raffleId, seller, n,
    priceUsd: +priceUsd.toFixed(2), createdAt: Date.now(), status: "open",
  };
  state.market.push(l);
  save();
  ledger("market-list", { listing: l.id, raffle: raffleId, seller, n, priceUsd: l.priceUsd });
  return { ok: true, id: l.id };
}

export function cancelListing(id: string, seller: string): { ok: boolean; why?: string } {
  const l = state.market.find((x) => x.id === id && x.status === "open");
  if (!l || l.seller !== seller) return { ok: false, why: "no such open listing" };
  l.status = "cancelled";
  save();
  ledger("market-cancel", { listing: id, seller });
  return { ok: true };
}

/** Execute a fill. In live mode the buyer's USDC already arrived at the
 *  machine wallet (payment watcher calls this) — the seller leg goes out
 *  through the payout queue. Paper mode is pure bookkeeping. */
export function fillListing(id: string, buyer: string): { ok: boolean; why?: string } {
  const l = state.market.find((x) => x.id === id && x.status === "open");
  if (!l) return { ok: false, why: "listing gone" };
  const r = state.raffles.find((x) => x.id === l.raffleId);
  if (!r || r.status !== "open") return { ok: false, why: "raffle no longer open" };
  if (buyer === l.seller) return { ok: false, why: "self-fill" };

  // move the tickets: shrink seller entries, add a buyer entry
  let toMove = l.n;
  for (const t of r.sold) {
    if (t.buyer !== l.seller || toMove <= 0) continue;
    const take = Math.min(t.n, toMove);
    t.n -= take;
    toMove -= take;
  }
  r.sold = r.sold.filter((t) => t.n > 0);
  if (toMove > 0) { // seller's tickets vanished between list and fill
    l.status = "cancelled";
    save();
    return { ok: false, why: "seller no longer holds those tickets" };
  }
  r.sold.push({ buyer, n: l.n, paidUsd: +(l.n * l.priceUsd).toFixed(2), at: Date.now() });
  l.status = "filled";
  l.buyer = buyer;
  l.filledAt = Date.now();
  const gross = +(l.n * l.priceUsd).toFixed(2);
  if (cfg.live) {
    queuePayout({ kind: "usdc", to: l.seller, amountUsd: gross, raffleId: r.id, reason: `ticket sale ${l.id} (${l.n} @ $${l.priceUsd})` });
  }
  save();
  const implied = +(l.priceUsd * r.tickets).toFixed(0);
  ledger("market-fill", { listing: l.id, raffle: r.id, seller: l.seller, buyer, n: l.n, priceUsd: l.priceUsd, gross, impliedCardUsd: implied });
  log.info("market", `${buyer.slice(0, 12)} bought ${l.n} tix @ $${l.priceUsd} from ${l.seller.slice(0, 12)} (implies card $${implied})`);
  return { ok: true };
}

/** Open listings + implied price for a raffle. */
export function marketFor(raffleId: string): { listings: TicketListing[]; lastPriceUsd?: number; impliedCardUsd?: number } {
  const listings = state.market
    .filter((l) => l.raffleId === raffleId && l.status === "open")
    .sort((a, b) => a.priceUsd - b.priceUsd);
  const r = state.raffles.find((x) => x.id === raffleId);
  const last = state.market
    .filter((l) => l.raffleId === raffleId && l.status === "filled")
    .sort((a, b) => (b.filledAt ?? 0) - (a.filledAt ?? 0))[0];
  return {
    listings,
    lastPriceUsd: last?.priceUsd,
    impliedCardUsd: last && r ? +(last.priceUsd * r.tickets).toFixed(0) : undefined,
  };
}

/** Sweep: cancel listings whose raffle left "open". */
export function tickMarket(): void {
  let changed = false;
  for (const l of state.market) {
    if (l.status !== "open") continue;
    const r = state.raffles.find((x) => x.id === l.raffleId);
    if (!r || r.status !== "open") {
      l.status = "cancelled";
      changed = true;
    }
  }
  if (changed) save();
}
