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
  machineId?: string; // in a capsule machine (headline or junk filler)
  status: "vault" | "raffled" | "machined" | "awarded" | "holder_prize";
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
  commitSig?: string; // live mode: memo tx anchoring the commit on-chain
  revealSig?: string; // live mode: memo tx revealing the seed after the draw
  seed?: string; // revealed at resolution
  blockhash?: string; // the real chain blockhash used
  winner?: string;
  winnerIndex?: number; // the drawn ticket index — stored so verification never reconstructs it
  status: "open" | "refunded" | "resolved";
  resolvedAt?: number;
}

/** One prize inside a capsule machine — a card or a cash envelope. */
export interface Prize {
  kind: "card" | "cash";
  nft?: string;
  valueUsd: number;
  label: string;
  claimedBy?: string; // buyer wallet once popped
}

export interface CapsuleOpen {
  buyer: string;
  txSig: string; // buyer's payment tx (paper: simulated sig) — half the entropy
  slot: number;
  blockhash: string; // blockhash of the confirmation slot — the other half
  prizeIdx: number; // index into machine.prizes
  priceUsd: number; // what the rack was worth per capsule at this open
  at: number;
}

/**
 * A capsule machine: N capsules at a fixed price, prize table PUBLIC from
 * the start and committed (memo-anchored in live mode). Every open draws
 * uniformly from the REMAINING pool via sha256(machineId|txSig|blockhash) —
 * the buyer can't know the blockhash when signing, the machine doesn't
 * control the buyer's signature. Zero-edge: sum(prizes) == N * price.
 * Rule (in the manifest): when the headline card pops, the machine closes
 * and unclaimed cash rolls into the next machine — the house keeps nothing.
 */
export interface Machine {
  id: string;
  title: string;
  nft: string; // headline card
  capsules: number;
  priceUsd: number; // STARTING price (pool ÷ capsules); the live price floats — see capsules.ts
  prizes: Prize[];
  opens: CapsuleOpen[];
  commitHash: string; // sha256 of the manifest (prize table + rules)
  commitSig?: string;
  status: "open" | "closed";
  rolledInUsd: number; // cash rolled in from the previous machine
  rolledOutUsd?: number; // cash rolled to the next machine at close
  createdAt: number;
  closedAt?: number;
}

/** A secondary-market listing: tickets for sale by a current holder. */
export interface TicketListing {
  id: string;
  raffleId: string;
  seller: string;
  n: number;
  priceUsd: number; // per ticket
  createdAt: number;
  status: "open" | "filled" | "cancelled";
  buyer?: string;
  filledAt?: number;
}

interface State {
  walletUsd: number; // paper bankroll
  holderPoolUsd: number; // 50% of realized profit accumulates here
  realizedProfitUsd: number;
  rolloverUsd: number; // cash from closed machines, owed to the next machine
  vault: VaultCard[];
  raffles: Raffle[];
  machines: Machine[];
  market: TicketListing[];
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
  return {
    walletUsd: cfg.paperBudget, holderPoolUsd: 0, realizedProfitUsd: 0, rolloverUsd: 0,
    vault: [], raffles: [], machines: [], market: [], seenPaper: [],
  };
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
