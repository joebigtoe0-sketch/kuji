import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";

/**
 * All state in one JSON file + an append-only ledger (jsonl). Paper mode is
 * a simulation with receipts — the same shape the real thing will have.
 */

export interface VaultCard {
  nft: string; // Collector Crypt NFT address (real, even in paper mode)
  itemName: string;
  category: string;
  grade: string;
  gradingCompany: string;
  image?: string;
  paidUsd: number; // what the sniper paid (paper)
  compUsd: number; // what the comp engine said it was worth
  compBasis: string; // human-readable comp reasoning
  boughtAt: number;
  raffleId?: string; // assigned to a raffle
  status: "vault" | "raffled" | "awarded" | "holder_prize";
}

export interface Ticket {
  buyer: string; // paper buyer id
  n: number; // ticket count in this purchase
  paidUsd: number;
  at: number;
}

export interface Raffle {
  id: string;
  kind: "paid" | "holder";
  nft: string;
  title: string;
  tickets: number; // total tickets
  ticketUsd: number; // price per ticket (0 for holder raffles)
  sold: Ticket[];
  createdAt: number;
  fillDeadline: number; // fill-or-refund
  resolveSlot: number; // named FUTURE Solana slot in the commitment
  commitHash: string; // sha256(manifest | seed | resolveSlot) — published before sale
  seed?: string; // revealed at resolution
  blockhash?: string; // the real chain blockhash used
  winner?: string;
  winnerIndex?: number; // the drawn ticket index — stored so verification never reconstructs it
  status: "open" | "refunded" | "resolved";
  resolvedAt?: number;
}

interface State {
  walletUsd: number; // paper bankroll
  holderPoolUsd: number; // 50% of realized profit accumulates here
  realizedProfitUsd: number;
  vault: VaultCard[];
  raffles: Raffle[];
  /** listing index for comps: identityKey -> {price,nft,seen}[] */
  seenPaper: string[]; // nfts already paper-bought (never rebuy)
}

const FILE = path.join(cfg.dataDir, "state.json");
export const state: State = (() => {
  try {
    return { ...defaults(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return defaults();
  }
})();
function defaults(): State {
  return { walletUsd: cfg.paperBudget, holderPoolUsd: 0, realizedProfitUsd: 0, vault: [], raffles: [], seenPaper: [] };
}
export function save(): void {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 1));
}

/** Append-only receipts — every decision with its reasoning. */
export function ledger(kind: string, entry: Record<string, unknown>): void {
  const line = JSON.stringify({ at: Date.now(), kind, ...entry });
  fs.appendFileSync(path.join(cfg.dataDir, "ledger.jsonl"), line + "\n");
}
export function ledgerTail(n = 100): Record<string, unknown>[] {
  try {
    return fs.readFileSync(path.join(cfg.dataDir, "ledger.jsonl"), "utf8")
      .split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
