import { cfg } from "./config.js";
import { solUsd } from "./solprice.js";

/**
 * Collector Crypt marketplace client.
 * Verified against the live API 2026-08-26: GET /marketplace?page=N returns
 * 100 cards/page, newest listings first, each with a `listing` sub-object.
 * No API key; a real User-Agent is required (WAF).
 *
 * Listings are priced in USDC *or SOL* — a market scan on 2026-08-27 found
 * 525 of 4000 (13%) in SOL, and that is where most of the cheap inventory
 * lives. Everything is normalised to USD here so comps and edges compare
 * like with like; `currency`/`priceNative` are kept because the buy tx has
 * to be funded in the listing's own currency.
 */

const BASE = "https://api.collectorcrypt.com";
const H = { "user-agent": "nerdname/0.1 (the card machine)", accept: "application/json" };

export interface Listing {
  nft: string;
  itemName: string;
  category: string;
  grade: string;
  gradingCompany: string;
  language: string;
  image?: string;
  priceUsd: number; // normalised — what the sniper prices against
  currency: "USDC" | "SOL";
  priceNative: number; // the listed amount in its own currency
  insuredUsd: number;
  listedAt: number;
  seenAt: number;
}

/** Stable identity for "the same card in the same grade" — the comp group. */
export function identityKey(l: Pick<Listing, "itemName" | "grade" | "gradingCompany">): string {
  return [l.itemName, l.gradingCompany, l.grade]
    .join("|").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function fetchPage(page: number): Promise<Listing[]> {
  const res = await fetch(`${BASE}/marketplace?page=${page}`, { headers: H });
  if (!res.ok) throw new Error(`marketplace page ${page}: HTTP ${res.status}`);
  const j: any = await res.json();
  const sol = await solUsd(); // 0 when unknown → SOL listings are skipped
  const out: Listing[] = [];
  for (const c of j.filterNFtCard ?? []) {
    const price = Number(c?.listing?.price);
    if (!c?.nftAddress || !Number.isFinite(price) || price <= 0) continue;
    const currency = String(c?.listing?.currency ?? "USDC") === "SOL" ? "SOL" : "USDC";
    if (currency === "SOL" && !sol) continue; // never guess a conversion rate
    const priceUsd = currency === "SOL" ? +(price * sol).toFixed(2) : price;
    if (cfg.categories.length && !cfg.categories.includes(String(c.category ?? ""))) continue;
    out.push({
      nft: String(c.nftAddress),
      itemName: String(c.itemName ?? "").trim(),
      category: String(c.category ?? ""),
      grade: String(c.grade ?? ""),
      gradingCompany: String(c.gradingCompany ?? ""),
      language: String(c.language ?? ""),
      image: c.images?.front ?? c.frontImage ?? undefined,
      priceUsd,
      currency,
      priceNative: price,
      insuredUsd: Number(c.insuredValue) || 0,
      listedAt: Date.parse(c?.listing?.createdAt ?? "") || Date.now(),
      seenAt: Date.now(),
    });
  }
  return out;
}
