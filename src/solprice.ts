import { log } from "./log.js";

/**
 * SOL/USD, cached. 13% of Collector Crypt listings are priced in SOL
 * (and that is where most of the cheap inventory sits), so every price
 * has to be normalised to USD before comps or edges mean anything.
 *
 * Two independent sources: a stale price here would mis-value a real buy,
 * so if both fail we return 0 and callers SKIP SOL listings entirely
 * rather than guess.
 */

let cached = { usd: 0, at: 0 };
const TTL_MS = 5 * 60_000;

async function fromCoinbase(): Promise<number> {
  const r: any = await (await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot")).json();
  return Number(r?.data?.amount) || 0;
}
async function fromJupiter(): Promise<number> {
  const r: any = await (await fetch("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112")).json();
  const k = Object.keys(r ?? {})[0];
  return Number(r?.[k]?.usdPrice ?? r?.[k]?.price) || 0;
}

/** SOL price in USD, or 0 if unknown (callers must then skip SOL listings). */
export async function solUsd(): Promise<number> {
  if (cached.usd > 0 && Date.now() - cached.at < TTL_MS) return cached.usd;
  for (const src of [fromCoinbase, fromJupiter]) {
    try {
      const v = await src();
      // sanity band: a wildly wrong price is worse than no price
      if (v > 1 && v < 10_000) {
        cached = { usd: v, at: Date.now() };
        return v;
      }
    } catch { /* try the next source */ }
  }
  if (cached.usd > 0) return cached.usd; // stale beats nothing, briefly
  log.warn("solprice", "no SOL price available — SOL listings will be skipped this sweep");
  return 0;
}
