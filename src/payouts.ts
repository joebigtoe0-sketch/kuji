import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getMint,
} from "@solana/spl-token";
import { cfg } from "./config.js";
import { connection, sendTx, walletPk } from "./wallet.js";
import { transferAsset } from "./assets.js";
import { ledger } from "./store.js";
import { log } from "./log.js";
import { halted } from "./halt.js";

/**
 * The payout queue — everything the machine owes anyone: ticket refunds
 * (fill-or-refund, overpayment change) and NFT prizes to winners. Durable
 * (data/payouts.json), retried with backoff, never dropped: a payout that
 * keeps failing goes to status "stuck" and screams in the log until a human
 * looks. In paper mode entries are marked done immediately (bookkeeping).
 */

interface Payout {
  id: string;
  kind: "usdc" | "nft";
  to: string; // recipient wallet
  amountUsd?: number; // usdc payouts
  nft?: string; // nft payouts: the mint
  raffleId: string;
  reason: string;
  status: "queued" | "done" | "stuck";
  tries: number;
  sig?: string;
  createdAt: number;
}

const FILE = path.join(cfg.dataDir, "payouts.json");
const q: Payout[] = (() => {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; }
})();
const persist = () => fs.writeFileSync(FILE, JSON.stringify(q, null, 1));

export function queuePayout(p: Omit<Payout, "id" | "status" | "tries" | "createdAt">): void {
  const entry: Payout = { ...p, id: Math.random().toString(36).slice(2, 10), status: "queued", tries: 0, createdAt: Date.now() };
  if (!cfg.live) entry.status = "done"; // paper: the ledger line is the payout
  q.push(entry);
  persist();
  ledger(cfg.live ? "payout-queued" : "payout-paper", { ...p });
}

export const pendingPayouts = () => q.filter((p) => p.status === "queued");
export const stuckPayouts = () => q.filter((p) => p.status === "stuck");

async function sendUsdc(to: string, amountUsd: number, label: string): Promise<string> {
  const mint = new PublicKey(cfg.usdcMint);
  const dec = (await getMint(connection, mint)).decimals;
  const dest = new PublicKey(to);
  const from = getAssociatedTokenAddressSync(mint, walletPk, true);
  const destAta = getAssociatedTokenAddressSync(mint, dest, true);
  const amount = BigInt(Math.round(amountUsd * 10 ** dec));
  return sendTx([
    createAssociatedTokenAccountIdempotentInstruction(walletPk, destAta, dest, mint),
    createTransferCheckedInstruction(from, mint, destAta, walletPk, amount, dec),
  ], label);
}

// prize transfers dispatch on the asset standard (spl / core / cnft) —
// CC cards come in all three; see assets.ts
const sendNft = (to: string, nft: string, _label: string) => transferAsset(nft, to);

/** Work the queue — on a timer. One payout per tick keeps failure blast radius small. */
export async function tickPayouts(): Promise<void> {
  if (!cfg.live || halted()) return;
  const p = q.find((x) => x.status === "queued");
  if (!p) return;
  try {
    p.sig = p.kind === "usdc"
      ? await sendUsdc(p.to, p.amountUsd!, `refund $${p.amountUsd} → ${p.to.slice(0, 8)} (${p.reason})`)
      : await sendNft(p.to, p.nft!, `prize ${p.nft!.slice(0, 8)} → ${p.to.slice(0, 8)} (${p.reason})`);
    p.status = "done";
    ledger("payout-sent", { kind: p.kind, to: p.to, amountUsd: p.amountUsd, nft: p.nft, raffle: p.raffleId, sig: p.sig });
  } catch (e) {
    p.tries++;
    const why = String(e).slice(0, 140);
    if (p.tries >= 8) {
      p.status = "stuck";
      ledger("payout-STUCK", { kind: p.kind, to: p.to, amountUsd: p.amountUsd, nft: p.nft, raffle: p.raffleId, why });
      log.warn("payout", `STUCK after ${p.tries} tries: ${p.kind} → ${p.to} (${why}) — needs a human`);
    } else {
      log.warn("payout", `retry ${p.tries}/8: ${p.kind} → ${p.to.slice(0, 8)}: ${why}`);
    }
  }
  persist();
}
