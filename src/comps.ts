import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";
import { identityKey, type Listing } from "./cc.js";

/**
 * The comp engine — the whole business lives or dies here.
 *
 * v0 comps come from CURRENT listings of the exact same card+grade: the
 * candidate is the cheapest, the comp is the SECOND-cheapest times a haircut.
 * Logic: if we buy the floor, the next-cheapest ask is what the market is
 * actually willing to keep listing at — haircut it and that's a conservative
 * value. Requires MIN_COMPS same-card listings or we admit we have no idea.
 *
 * The index persists across runs (7-day expiry) so comp groups accumulate
 * beyond a single sweep.
 */

interface Row {
  nft: string;
  priceUsd: number;
  seenAt: number;
}
const FILE = path.join(cfg.dataDir, "compindex.json");
let index: Record<string, Row[]> = (() => {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; }
})();

export function ingest(listings: Listing[]): void {
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const l of listings) {
    const k = identityKey(l);
    const rows = (index[k] ?? []).filter((r) => r.nft !== l.nft && r.seenAt > cutoff);
    rows.push({ nft: l.nft, priceUsd: l.priceUsd, seenAt: l.seenAt });
    index[k] = rows;
  }
  // global expiry sweep
  for (const [k, rows] of Object.entries(index)) {
    const live = rows.filter((r) => r.seenAt > cutoff);
    if (live.length) index[k] = live;
    else delete index[k];
  }
  fs.writeFileSync(FILE, JSON.stringify(index));
}

export interface Comp {
  compUsd: number;
  basis: string;
  groupSize: number;
}

/** Conservative value for a listing, or null if we can't honestly price it. */
export function compFor(l: Listing): Comp | null {
  const rows = index[identityKey(l)] ?? [];
  if (rows.length < cfg.minComps) return null;
  const prices = rows.map((r) => r.priceUsd).sort((a, b) => a - b);
  // candidate should BE the floor — otherwise it's not a snipe
  if (l.priceUsd > prices[0] + 0.01) return null;
  const second = prices.find((p) => p > l.priceUsd + 0.01);
  if (!second) return null;
  const compUsd = +(second * cfg.compHaircut).toFixed(2);
  return {
    compUsd,
    groupSize: rows.length,
    basis: `2nd-lowest of ${rows.length} live listings ($${second}) x ${cfg.compHaircut} haircut`,
  };
}

export function indexStats(): { groups: number; rows: number } {
  const ks = Object.keys(index);
  return { groups: ks.length, rows: ks.reduce((s, k) => s + index[k].length, 0) };
}
