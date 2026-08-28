import { cfg } from "./config.js";
import { fetchPage, type Listing } from "./cc.js";
import { ingest, compFor, indexStats } from "./comps.js";
import { state, save, ledger } from "./store.js";
import { log } from "./log.js";
import { realBuy } from "./buyer.js";
import { halted } from "./halt.js";
import { usdcBalance } from "./wallet.js";

/**
 * The sniper — scans newest listings, prices them against the comp index,
 * and (in paper mode) "buys" anything with a real edge. Every buy and every
 * near-miss is a ledger line with the full reasoning: the paper phase exists
 * to find out whether the edges are real before a dollar moves.
 */

let scanning = false;

export async function scan(): Promise<void> {
  if (scanning) return;
  if (halted()) { log.warn("sniper", "halted — skipping sweep"); return; }
  scanning = true;
  try {
    // live mode prices guardrails off the real bankroll, not the paper number
    if (cfg.live) state.walletUsd = await usdcBalance();
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
      // bootstrap: inventory beats edge — cheap cards clear a relaxed bar
      const minEdge = cfg.bootstrap && l.priceUsd <= cfg.bootstrapMaxCardUsd ? cfg.bootstrapMinEdge : cfg.minEdge;
      if (edge < minEdge) {
        if (edge > minEdge * 0.6)
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
      if (cfg.live && l.priceUsd > cfg.liveMaxCardUsd) {
        ledger("skip-live-cap", { nft: l.nft, item: l.itemName, price: l.priceUsd, cap: cfg.liveMaxCardUsd });
        continue;
      }
      // BUY — real tx in live mode, bookkeeping-only in paper mode
      if (cfg.live) {
        const r = await realBuy(l);
        if (!r.ok) continue; // reason already in the ledger
        state.walletUsd = await usdcBalance();
      } else {
        state.walletUsd -= l.priceUsd;
      }
      state.seenPaper.push(l.nft);
      state.vault.push({
        nft: l.nft, itemName: l.itemName, category: l.category, grade: l.grade,
        gradingCompany: l.gradingCompany, image: l.image,
        paidUsd: l.priceUsd, compUsd: comp.compUsd, compBasis: comp.basis,
        boughtAt: Date.now(), status: "vault",
      });
      buys++;
      boughtIdentities.add(idKey);
      ledger(cfg.live ? "live-buy-vaulted" : "paper-buy", {
        nft: l.nft, item: l.itemName, category: l.category, grade: `${l.gradingCompany} ${l.grade}`,
        price: l.priceUsd, comp: comp.compUsd, edge: +edge.toFixed(3), basis: comp.basis,
        wallet: +state.walletUsd.toFixed(2),
      });
      log.info("sniper", `${cfg.live ? "LIVE" : "PAPER"} BUY ${l.itemName.slice(0, 60)} @ $${l.priceUsd} (comp $${comp.compUsd}, edge ${(edge * 100).toFixed(0)}%)`);
    }
    const junk = cfg.bootstrap ? await junkPass(all) : 0;
    save();
    log.info("sniper", `sweep: ${all.length} listings, index ${st.groups} groups/${st.rows} rows, ${considered} priced, ${buys} ${cfg.live ? "live" : "paper"} buys${junk ? `, ${junk} junk` : ""}, wallet $${state.walletUsd.toFixed(2)}`);
  } finally {
    scanning = false;
  }
}

/**
 * The junk pass — penny cards for the capsule machine, NO edge required.
 * A capsule that pops a real (worthless) card beats a 12¢ cash envelope:
 * same EV, infinitely better theater. Valued at exactly what they cost,
 * so the zero-edge math never lies.
 */
async function junkPass(all: Listing[]): Promise<number> {
  const held = state.vault.filter((v) => v.role === "junk" && v.status === "vault").length;
  const need = Math.min(cfg.junkTarget - held, cfg.junkBuysPerSweep);
  if (need <= 0) return 0;
  const ids = new Set(state.vault.map((v) => `${v.itemName}|${v.gradingCompany}|${v.grade}`.toLowerCase()));
  const candidates = all
    .filter((l) => l.priceUsd > 0 && l.priceUsd <= cfg.junkMaxUsd)
    .filter((l) => !state.seenPaper.includes(l.nft) && !state.vault.some((v) => v.nft === l.nft))
    .sort((a, b) => a.priceUsd - b.priceUsd);
  let bought = 0;
  for (const l of candidates) {
    if (bought >= need) break;
    const idKey = `${l.itemName}|${l.gradingCompany}|${l.grade}`.toLowerCase();
    if (ids.has(idKey)) continue;
    if (state.walletUsd < l.priceUsd) break;
    if (cfg.live) {
      const r = await realBuy(l);
      if (!r.ok) continue;
      state.walletUsd = await usdcBalance();
    } else {
      state.walletUsd -= l.priceUsd;
    }
    state.seenPaper.push(l.nft);
    state.vault.push({
      nft: l.nft, itemName: l.itemName, category: l.category, grade: l.grade,
      gradingCompany: l.gradingCompany, image: l.image,
      paidUsd: l.priceUsd, compUsd: l.priceUsd, compBasis: "junk filler — valued at cost",
      boughtAt: Date.now(), status: "vault", role: "junk",
    });
    ids.add(idKey);
    bought++;
    ledger(cfg.live ? "live-buy-junk" : "paper-buy-junk", { nft: l.nft, item: l.itemName, price: l.priceUsd });
    log.info("sniper", `${cfg.live ? "LIVE" : "PAPER"} JUNK ${l.itemName.slice(0, 50)} @ $${l.priceUsd} (capsule filler)`);
  }
  return bought;
}
