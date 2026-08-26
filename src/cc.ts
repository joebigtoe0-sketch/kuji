import { cfg } from "./config.js";

/**
 * Collector Crypt marketplace client (read-only in paper mode).
 * Verified against the live API 2026-08-26: GET /marketplace?page=N returns
 * 100 cards/page, newest listings first, each with a `listing` sub-object
 * priced in USDC. No API key; a real User-Agent is required (WAF).
 */

const BASE = "https://api.collectorcrypt.com";
const H = { "user-agent": "nerdname/0.1 (the card machine, paper mode)", accept: "application/json" };

export interface Listing {
  nft: string;
  itemName: string;
  category: string;
  grade: string;
  gradingCompany: string;
  language: string;
  image?: string;
  priceUsd: number;
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
  const out: Listing[] = [];
  for (const c of j.filterNFtCard ?? []) {
    const price = Number(c?.listing?.price);
    if (!c?.nftAddress || !Number.isFinite(price) || price <= 0) continue;
    if (String(c?.listing?.currency ?? "USDC") !== "USDC") continue;
    if (cfg.categories.length && !cfg.categories.includes(String(c.category ?? ""))) continue;
    out.push({
      nft: String(c.nftAddress),
      itemName: String(c.itemName ?? "").trim(),
      category: String(c.category ?? ""),
      grade: String(c.grade ?? ""),
      gradingCompany: String(c.gradingCompany ?? ""),
      language: String(c.language ?? ""),
      image: c.images?.front ?? c.frontImage ?? undefined,
      priceUsd: price,
      insuredUsd: Number(c.insuredValue) || 0,
      listedAt: Date.parse(c?.listing?.createdAt ?? "") || Date.now(),
      seenAt: Date.now(),
    });
  }
  return out;
}
