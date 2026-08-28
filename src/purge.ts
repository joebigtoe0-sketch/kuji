import { state, save, ledger } from "./store.js";
import { ownsAsset } from "./assets.js";
import { cfg } from "./config.js";
import { log } from "./log.js";

/**
 * Remove paper-mode leftovers before real money can touch them.
 *
 * Deploying in paper mode first is the sensible way to preview the site,
 * but the simulator fills it with raffles, ticket buyers and market
 * listings. Flip to live with that still on screen and a real person can
 * pay real USDC into a raffle for a card the machine NEVER BOUGHT: the
 * watcher would credit the tickets, the draw would resolve, and the prize
 * payout would fail because we do not own the card. Money in, nothing out.
 *
 * How demo data is identified, without needing a flag on old records:
 *   - raffles and machines: paper mode never publishes an on-chain commit,
 *     so a missing commitSig means it was created in paper mode
 *   - vault cards: the real test is ownership. Paper "buys" are bookkeeping
 *     only, so the chain says we do not hold them.
 */

export interface PurgeResult {
  raffles: number; machines: number; listings: number; cards: number; kept: number;
}

export async function purgeDemo(): Promise<PurgeResult> {
  const out: PurgeResult = { raffles: 0, machines: 0, listings: 0, cards: 0, kept: 0 };
  const demoRaffleIds = new Set<string>();

  // DELETE rather than close. Marking a demo raffle "refunded" still leaves
  // it on the public page, and "refunded" reads as though real people were
  // paid back — which never happened, because no real money was ever in it.
  // The ledger keeps the record; the storefront should show nothing.
  for (const r of state.raffles) if (!r.commitSig) demoRaffleIds.add(r.id);
  out.raffles = state.raffles.filter((r) => !r.commitSig).length;
  state.raffles = state.raffles.filter((r) => !!r.commitSig);

  out.machines = state.machines.filter((m) => !m.commitSig).length;
  state.machines = state.machines.filter((m) => !!m.commitSig);

  out.listings = state.market.filter((l) => demoRaffleIds.has(l.raffleId)).length;
  state.market = state.market.filter((l) => !demoRaffleIds.has(l.raffleId));

  // vault: keep only what we actually hold on chain
  const keep = [];
  for (const v of state.vault) {
    if (v.status === "awarded" || v.status === "holder_prize") { keep.push(v); continue; } // history
    let owned = false;
    try { owned = await ownsAsset(v.nft); } catch { owned = false; }
    if (owned) { keep.push(v); out.kept++; } else { out.cards++; }
  }
  state.vault = keep;

  // paper bookkeeping numbers are meaningless against a real wallet
  state.walletUsd = 0;
  state.realizedProfitUsd = 0;
  state.holderPoolUsd = 0;
  state.rolloverUsd = 0;
  state.seenPaper = [];

  save();
  ledger("purge-demo", { ...out, note: "paper-mode artifacts cleared before live operation" });
  log.info("purge", `cleared demo data: ${out.raffles} raffles, ${out.machines} machines, ${out.listings} listings, ${out.cards} unowned cards (kept ${out.kept} we actually hold)`);
  return out;
}

/** Is this raffle/machine safe to take real money for? */
export const isReal = (x: { commitSig?: string }): boolean => !cfg.live || !!x.commitSig;
