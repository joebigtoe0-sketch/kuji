import { cfg } from "./config.js";
import { state, save, ledger } from "./store.js";
import { lastSighting } from "./comps.js";
import { log } from "./log.js";

/**
 * The grader — did the paper edges turn out to be real?
 *
 * A paper buy leaves the REAL listing on the market. What happens to that
 * listing is the experiment's result:
 *   TAKEN        — it vanished at our price: someone real agreed. Validated.
 *   STILL-LISTED — still sitting there after the grading window: the market
 *                  disagrees with our edge. Thesis weakened.
 *   REPRICED     — the seller moved the price; informative either way.
 *
 * Grades accumulate into the number that decides whether real money ever
 * moves: the validation rate.
 */

export interface Grade {
  nft: string;
  item: string;
  paidUsd: number;
  compUsd: number;
  outcome: "taken" | "still-listed" | "repriced";
  detail: string;
  at: number;
}

export function grades(): Grade[] {
  return (state as any).grades ?? [];
}

export async function gradeVault(): Promise<void> {
  const st: any = state;
  st.grades = st.grades ?? [];
  const gradedNfts = new Set(st.grades.map((g: Grade) => g.nft));
  const due = state.vault.filter(
    (v) => !gradedNfts.has(v.nft) && Date.now() - v.boughtAt > cfg.gradeAfterH * 3600_000,
  );
  let n = 0;
  for (const v of due) {
    const s = lastSighting(v.nft);
    let outcome: Grade["outcome"];
    let detail: string;
    const staleMs = Date.now() - (s?.lastSeenAt ?? 0);
    // "not seen for 2+ sweeps" — sweeps only see the newest pages, so an old
    // listing naturally ages out of sight; treat 'gone from the newest pages
    // AND price never changed' carefully: our ground truth is imperfect and
    // says so in the grade detail.
    if (!s || staleMs > 3 * cfg.scanEveryMin * 60_000) {
      outcome = "taken";
      detail = `listing not sighted for ${(staleMs / 3600_000).toFixed(1)}h — sold or delisted at ~$${v.paidUsd}`;
    } else if (Math.abs(s.priceUsd - v.paidUsd) > 0.5) {
      outcome = "repriced";
      detail = `seller moved $${v.paidUsd} -> $${s.priceUsd}`;
    } else {
      outcome = "still-listed";
      detail = `still on the market at $${s.priceUsd} after ${cfg.gradeAfterH}h — the edge nobody wanted`;
    }
    const g: Grade = { nft: v.nft, item: v.itemName, paidUsd: v.paidUsd, compUsd: v.compUsd, outcome, detail, at: Date.now() };
    st.grades.push(g);
    ledger("grade", { ...g });
    n++;
  }
  if (n) {
    save();
    const all: Grade[] = st.grades;
    const taken = all.filter((g) => g.outcome === "taken").length;
    log.info("grader", `graded ${n} — validation rate ${taken}/${all.length} (${Math.round((100 * taken) / all.length)}%)`);
  }
}

export function gradeStats(): { graded: number; taken: number; stillListed: number; repriced: number; validationPct: number } {
  const all = grades();
  const taken = all.filter((g) => g.outcome === "taken").length;
  const still = all.filter((g) => g.outcome === "still-listed").length;
  const rep = all.filter((g) => g.outcome === "repriced").length;
  return { graded: all.length, taken, stillListed: still, repriced: rep, validationPct: all.length ? Math.round((100 * taken) / all.length) : 0 };
}
