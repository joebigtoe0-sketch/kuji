import { state } from "./store.js";

/**
 * What each card ACTUALLY returned — the live-mode scoreboard.
 *
 * The paper-era grader asked "would someone else have bought this at our
 * price?", which only works while we are not really buying. Once real
 * money moves, the honest question is simpler and harder: we paid X for
 * this card, what did it bring back?
 */

export interface CardResult {
  nft: string; item: string; image?: string;
  paidUsd: number; compUsd: number;
  state: "in the vault" | "in a raffle" | "in a machine" | "won by a holder" | "raffled to a winner";
  returnedUsd: number | null;   // null = not resolved yet, which is not the same as zero
  detail: string;
}

export function results(): { cards: CardResult[]; spent: number; returned: number; open: number } {
  const cards: CardResult[] = [];
  for (const v of state.vault) {
    const r = state.raffles.find((x) => x.nft === v.nft);
    const m = state.machines.find((x) => x.prizes.some((p) => p.nft === v.nft));
    let st: CardResult["state"] = "in the vault";
    let returnedUsd: number | null = null;
    let detail = "waiting for a raffle or a machine";

    if (r && r.status === "resolved") {
      const gross = r.sold.reduce((s, t) => s + t.paidUsd, 0);
      st = r.kind === "holder" ? "won by a holder" : "raffled to a winner";
      returnedUsd = +gross.toFixed(2);
      detail = r.kind === "holder"
        ? `given free to ${r.sold.length} holders — funded by profit, returns nothing by design`
        : `${r.sold.reduce((s, t) => s + t.n, 0)} tickets sold at $${r.ticketUsd}`;
    } else if (r && r.status === "open") {
      st = "in a raffle";
      detail = `${r.sold.reduce((s, t) => s + t.n, 0)}/${r.tickets} tickets sold so far`;
    } else if (m) {
      st = "in a machine";
      const prize = m.prizes.find((p) => p.nft === v.nft)!;
      if (prize.claimedBy) {
        returnedUsd = +m.opens.reduce((s, o) => s + (o.priceUsd ?? 0), 0).toFixed(2);
        detail = `pulled from machine ${m.id.slice(0, 8)} — that rack took $${returnedUsd} across ${m.opens.length} opens`;
      } else {
        detail = `still in the rack of machine ${m.id.slice(0, 8)}`;
      }
    }
    cards.push({ nft: v.nft, item: v.itemName, image: v.image, paidUsd: v.paidUsd, compUsd: v.compUsd, state: st, returnedUsd, detail });
  }
  const spent = +cards.reduce((s, c) => s + c.paidUsd, 0).toFixed(2);
  const returned = +cards.reduce((s, c) => s + (c.returnedUsd ?? 0), 0).toFixed(2);
  const open = cards.filter((c) => c.returnedUsd === null).length;
  return { cards: cards.reverse(), spent, returned, open };
}
