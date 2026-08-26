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

// flat sightings map: nft -> latest sighting. The grader's ground truth —
// a listing that stops appearing at our snipe price was TAKEN (validated).
const SIGHT_FILE = path.join(cfg.dataDir, "sightings.json");
let sightings: Record<string, { priceUsd: number; lastSeenAt: number }> = (() => {
  try { return JSON.parse(fs.readFileSync(SIGHT_FILE, "utf8")); } catch { return {}; }
})();
export function lastSighting(nft: string): { priceUsd: number; lastSeenAt: number } | null {
  return sightings[nft] ?? null;
}

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
  for (const l of listings) sightings[l.nft] = { priceUsd: l.priceUsd, lastSeenAt: l.seenAt };
  const scut = Date.now() - 14 * 86_400_000;
  for (const [k, v] of Object.entries(sightings)) if (v.lastSeenAt < scut) delete sightings[k];
  fs.writeFileSync(SIGHT_FILE, JSON.stringify(sightings));
}

export interface Comp {
  compUsd: number;
  basis: string;
  groupSize: number;
}

/**
 * Conservative value for a listing, or null if we can't honestly price it.
 *
 * v1 hardening (the sweep-#1 lesson, where two moonshot asks manufactured a
 * "72% edge" on sealed product):
 *  - comps only from listings seen in the last 48h — a week-old ask that
 *    nobody took is not evidence of value
 *  - the comp is capped at the group MEDIAN: one realistic ask among
 *    moonshots can no longer set the price
 *  - a comp group whose second-lowest is more than 2.5x the floor is
 *    declared unpriceable — that spread means the "market" here is noise
 */
export function compFor(l: Listing): Comp | null {
  const fresh = Date.now() - 48 * 3600_000;
  const rows = (index[identityKey(l)] ?? []).filter((r) => r.seenAt > fresh);
  if (rows.length < cfg.minComps) return null;
  const prices = rows.map((r) => r.priceUsd).sort((a, b) => a - b);
  // candidate should BE the floor — otherwise it's not a snipe
  if (l.priceUsd > prices[0] + 0.01) return null;
  const second = prices.find((p) => p > l.priceUsd + 0.01);
  if (!second) return null;
  if (second > l.priceUsd * 2.5) return null; // gap too wide to mean anything
  const median = prices[Math.floor(prices.length / 2)];
  const anchor = Math.min(second, median);
  const compUsd = +(anchor * cfg.compHaircut).toFixed(2);
  return {
    compUsd,
    groupSize: rows.length,
    basis: `min(2nd-lowest $${second}, median $${median}) of ${rows.length} fresh listings x ${cfg.compHaircut} haircut`,
  };
}

export function indexStats(): { groups: number; rows: number } {
  const ks = Object.keys(index);
  return { groups: ks.length, rows: ks.reduce((s, k) => s + index[k].length, 0) };
}
