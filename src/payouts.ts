import fs from "node:fs";
import path from "node:path";
import { PublicKey, SystemProgram } from "@solana/web3.js";
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

/**
 * Refuse to send anything to an address nobody can sign for.
 *
 * A bonding curve or AMM pool holding tokens looks like a holder. If one
 * ever wins, transferring the prize to its program-derived address puts
 * the card somewhere with no private key: unrecoverable. Better a loud
 * stuck payout a human resolves than a card burned in public.
 */
async function isProgramOwned(addr: string): Promise<boolean> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(addr));
    if (!info) return false;                       // unfunded wallet, fine
    return !info.owner.equals(SystemProgram.programId) || info.executable;
  } catch {
    return false;                                   // can't tell — don't block on a hiccup
  }
}

/**
 * Work the queue — on a timer.
 *
 * USDC owed to the SAME wallet is combined into one transfer. Capsule
 * prizes are mostly small change (a $1 capsule machine is full of sub-$1
 * envelopes), so opening three capsules used to mean three separate
 * transactions over a minute — and if that wallet has no USDC account yet,
 * WE pay the ~0.002 SOL rent to create one. Paying 16c three times to a
 * new wallet could cost more in rent than the prizes are worth. Coalescing
 * means one account creation, one transfer, one line in their wallet.
 */
export async function tickPayouts(): Promise<void> {
  if (!cfg.live || halted()) return;
  const p = q.find((x) => x.status === "queued");
  if (!p) return;
  // everything else queued for this wallet in the same currency rides along
  const batch = p.kind === "usdc"
    ? q.filter((x) => x.status === "queued" && x.kind === "usdc" && x.to === p.to)
    : [p];
  const batchUsd = +batch.reduce((s, x) => s + (x.amountUsd ?? 0), 0).toFixed(6);
  if (await isProgramOwned(p.to)) {
    p.status = "stuck";
    ledger("payout-BLOCKED", { kind: p.kind, to: p.to, amountUsd: p.amountUsd, nft: p.nft, raffle: p.raffleId, why: "recipient is a program-owned address (bonding curve / pool / PDA) — sending there would destroy the prize" });
    log.warn("payout", `BLOCKED: ${p.to} is program-owned, not a wallet. ${p.kind} payout held for review — nobody can sign for that address.`);
    persist();
    return;
  }
  try {
    const sig = p.kind === "usdc"
      ? await sendUsdc(p.to, batchUsd, `pay $${batchUsd} → ${p.to.slice(0, 8)}${batch.length > 1 ? ` (${batch.length} items)` : ""} (${p.reason})`)
      : await sendNft(p.to, p.nft!, `prize ${p.nft!.slice(0, 8)} → ${p.to.slice(0, 8)} (${p.reason})`);
    for (const x of batch) { x.sig = sig; x.status = "done"; }
    ledger("payout-sent", { kind: p.kind, to: p.to, amountUsd: p.kind === "usdc" ? batchUsd : undefined, items: batch.length, nft: p.nft, raffle: p.raffleId, sig });
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
