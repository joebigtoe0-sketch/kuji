import { cfg } from "./config.js";
import { fetchPage, type Listing } from "./cc.js";
import { ingest, compFor, indexStats } from "./comps.js";
import { state, save, ledger } from "./store.js";
import { log } from "./log.js";

/**
 * The sniper — scans newest listings, prices them against the comp index,
 * and (in paper mode) "buys" anything with a real edge. Every buy and every
 * near-miss is a ledger line with the full reasoning: the paper phase exists
 * to find out whether the edges are real before a dollar moves.
 */

let scanning = false;

export async function scan(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const all: Listing[] = [];
    for (let p = 1; p <= cfg.scanPages; p++) {
      try {
        all.push(...await fetchPage(p));
      } catch (e) {
        log.warn("sniper", `page ${p}: ${String(e).slice(0, 80)}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 400)); // polite
    }
    ingest(all);
    const st = indexStats();

    let buys = 0, considered = 0;
    const boughtIdentities = new Set(state.vault.map((v) => `${v.itemName}|${v.gradingCompany}|${v.grade}`.toLowerCase()));
    for (const l of all) {
      if (l.priceUsd < cfg.priceMin || l.priceUsd > cfg.priceMax) continue;
      if (state.seenPaper.includes(l.nft)) continue;
      if (state.vault.some((v) => v.nft === l.nft)) continue;
      const comp = compFor(l);
      if (!comp) continue;
      considered++;
      const edge = (comp.compUsd - l.priceUsd) / comp.compUsd;
      // an edge too good to be true usually is — thin comp groups with two
      // moonshot asks produce "72% edges" on sealed product. Review, not buy.
      if (edge > cfg.maxEdge) {
        ledger("review-sus-edge", { nft: l.nft, item: l.itemName, price: l.priceUsd, comp: comp.compUsd, edge: +edge.toFixed(3), basis: comp.basis });
        continue;
      }
      // one copy per card identity until the first one is graded out
      const idKey = `${l.itemName}|${l.gradingCompany}|${l.grade}`.toLowerCase();
      if (boughtIdentities.has(idKey)) continue;
      if (edge < cfg.minEdge) {
        if (edge > cfg.minEdge * 0.6)
          ledger("near-miss", { nft: l.nft, item: l.itemName, price: l.priceUsd, comp: comp.compUsd, edge: +edge.toFixed(3), basis: comp.basis });
        continue;
      }
      if (buys >= cfg.maxBuysPerSweep) {
        ledger("skip-sweep-cap", { nft: l.nft, item: l.itemName, price: l.priceUsd });
        continue;
      }
      if (l.priceUsd > state.walletUsd * cfg.maxPerCardFrac + 0.01) {
        ledger("skip-concentration", { nft: l.nft, item: l.itemName, price: l.priceUsd, wallet: +state.walletUsd.toFixed(2), cap: cfg.maxPerCardFrac });
        continue;
      }
      if (state.walletUsd < l.priceUsd) {
        ledger("skip-broke", { nft: l.nft, item: l.itemName, price: l.priceUsd, wallet: +state.walletUsd.toFixed(2) });
        continue;
      }
      // PAPER BUY
      state.walletUsd -= l.priceUsd;
      state.seenPaper.push(l.nft);
      state.vault.push({
        nft: l.nft, itemName: l.itemName, category: l.category, grade: l.grade,
        gradingCompany: l.gradingCompany, image: l.image,
        paidUsd: l.priceUsd, compUsd: comp.compUsd, compBasis: comp.basis,
        boughtAt: Date.now(), status: "vault",
      });
      buys++;
      boughtIdentities.add(idKey);
      ledger("paper-buy", {
        nft: l.nft, item: l.itemName, category: l.category, grade: `${l.gradingCompany} ${l.grade}`,
        price: l.priceUsd, comp: comp.compUsd, edge: +edge.toFixed(3), basis: comp.basis,
        wallet: +state.walletUsd.toFixed(2),
      });
      log.info("sniper", `PAPER BUY ${l.itemName.slice(0, 60)} @ $${l.priceUsd} (comp $${comp.compUsd}, edge ${(edge * 100).toFixed(0)}%)`);
    }
    save();
    log.info("sniper", `sweep: ${all.length} listings, index ${st.groups} groups/${st.rows} rows, ${considered} priced, ${buys} paper buys, wallet $${state.walletUsd.toFixed(2)}`);
  } finally {
    scanning = false;
  }
}
