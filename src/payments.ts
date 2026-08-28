import fs from "node:fs";
import path from "node:path";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, getMint,
} from "@solana/spl-token";
import { TransactionInstruction } from "@solana/web3.js";
import { cfg } from "./config.js";
import { connection, walletPk } from "./wallet.js";
import { state, save, ledger } from "./store.js";
import { queuePayout } from "./payouts.js";
import { openCapsules, quote } from "./capsules.js";
import { fillListing } from "./market.js";
import { blockhashOfSlot } from "./draw.js";
import { isReal } from "./purge.js";
import { log } from "./log.js";

/**
 * Real ticket payments (LIVE_MODE), Solana Pay style but self-hosted:
 *
 * 1. The raffle page asks /api/paytx?raffle&n&payer — we build an unsigned
 *    tx: USDC transfer (buyer → machine ATA) + memo NERD:TICKETS:<id>:<n>.
 * 2. Phantom signs and sends it; the buyer pays fees.
 * 3. watchPayments() polls our USDC ATA's signatures, parses new txs, and
 *    credits tickets from what ACTUALLY arrived (never from what the memo
 *    claims): floor(received / ticketUsd), capped at tickets remaining.
 *    Excess (overpay, sellout race) goes back via the payout queue.
 *
 * ANSEM is accepted at the operator-set ANSEM_PER_USD rate when configured —
 * same memo, ANSEM ATA watched separately.
 */

const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SIGS_FILE = path.join(cfg.dataDir, "paysigs.json");
let seenSigs: string[] = (() => {
  try { return JSON.parse(fs.readFileSync(SIGS_FILE, "utf8")); } catch { return []; }
})();
const persistSigs = () => fs.writeFileSync(SIGS_FILE, JSON.stringify(seenSigs.slice(-2000)));

/** Unsigned transfer+memo tx — the shared shape of every purchase. */
async function buildTransfer(payer: string, usd: number, memo: string, currency: "usdc" | "ansem"): Promise<string> {
  const useAnsem = currency === "ansem" && !!cfg.ansemMint && cfg.ansemPerUsd > 0;
  const mint = new PublicKey(useAnsem ? cfg.ansemMint : cfg.usdcMint);
  const dec = (await getMint(connection, mint)).decimals;
  const uiAmount = useAnsem ? usd * cfg.ansemPerUsd : usd;
  const amount = BigInt(Math.round(uiAmount * 10 ** dec));
  const payerPk = new PublicKey(payer);
  const from = getAssociatedTokenAddressSync(mint, payerPk, true);
  const to = getAssociatedTokenAddressSync(mint, walletPk, true);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payerPk, to, walletPk, mint),
    createTransferCheckedInstruction(from, mint, to, payerPk, amount, dec),
    new TransactionInstruction({
      keys: [{ pubkey: payerPk, isSigner: true, isWritable: false }],
      programId: MEMO,
      data: Buffer.from(memo, "utf8"),
    }),
  );
  tx.feePayer = payerPk;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

/** Build the unsigned payment tx for the raffle buy widget. */
export async function buildPayTx(raffleId: string, n: number, payer: string, currency: "usdc" | "ansem" = "usdc"): Promise<{ ok: boolean; tx?: string; why?: string }> {
  const r = state.raffles.find((x) => x.id === raffleId);
  if (!r || r.status !== "open" || r.kind !== "paid") return { ok: false, why: "no open paid raffle" };
  if (!isReal(r)) return { ok: false, why: "this is a paper-mode demo raffle and cannot be bought" };
  const left = r.tickets - r.sold.reduce((s, t) => s + t.n, 0);
  if (n < 1 || n > left) return { ok: false, why: `only ${left} tickets left` };
  const usd = +(n * r.ticketUsd).toFixed(2);
  return { ok: true, tx: await buildTransfer(payer, usd, `NERD:TICKETS:${raffleId}:${n}`, currency) };
}

/** Capsule opens: the payment tx ITSELF becomes the draw entropy. Priced
 *  at the LIVE rack price; if it moves before confirmation the buyer gets
 *  whatever their payment buys and the remainder is refunded. */
export async function buildCapsulePayTx(machineId: string, n: number, payer: string, currency: "usdc" | "ansem" = "usdc"): Promise<{ ok: boolean; tx?: string; why?: string }> {
  const m = state.machines.find((x) => x.id === machineId);
  if (!m || m.status !== "open") return { ok: false, why: "no open machine" };
  if (!isReal(m)) return { ok: false, why: "this is a paper-mode demo machine and cannot be bought" };
  const left = m.prizes.filter((p) => !p.claimedBy).length;
  if (n < 1 || n > Math.min(left, 25)) return { ok: false, why: `1-${Math.min(left, 25)} capsules per tx` };
  const q = quote(m, n);
  if (q.totalUsd < 0.05) return { ok: false, why: "rack is worth less than the minimum payment — buy more capsules at once" };
  return { ok: true, tx: await buildTransfer(payer, q.totalUsd, `NERD:CAPSULE:${machineId}:${n}`, currency) };
}

/** Secondary-market fill: buyer pays the machine wallet (escrow leg). */
export async function buildMarketPayTx(listingId: string, payer: string): Promise<{ ok: boolean; tx?: string; why?: string }> {
  const l = state.market.find((x) => x.id === listingId && x.status === "open");
  if (!l) return { ok: false, why: "listing gone" };
  const usd = +(l.n * l.priceUsd).toFixed(2);
  return { ok: true, tx: await buildTransfer(payer, usd, `NERD:MKT:${listingId}`, "usdc") };
}

/** How much of `mint` landed in OUR ATA in this tx, and who sent it. */
function receivedDelta(parsed: any, mint: string): { amount: number; payer?: string } {
  const me = walletPk.toBase58();
  const pre = (parsed?.meta?.preTokenBalances ?? []).find((b: any) => b.mint === mint && b.owner === me);
  const post = (parsed?.meta?.postTokenBalances ?? []).find((b: any) => b.mint === mint && b.owner === me);
  const amount = (post?.uiTokenAmount?.uiAmount ?? 0) - (pre?.uiTokenAmount?.uiAmount ?? 0);
  const keys = parsed?.transaction?.message?.accountKeys ?? [];
  const payer = keys.find((k: any) => k.signer)?.pubkey;
  return { amount, payer: payer ? String(payer) : undefined };
}

function memoOf(parsed: any): string | undefined {
  for (const ix of parsed?.transaction?.message?.instructions ?? []) {
    if (ix?.program === "spl-memo" && typeof ix?.parsed === "string") return ix.parsed;
  }
  return undefined;
}

/** Poll for incoming ticket payments — on a timer in live mode. */
export async function watchPayments(): Promise<void> {
  if (!cfg.live) return;
  const mints = [cfg.usdcMint, ...(cfg.ansemMint && cfg.ansemPerUsd > 0 ? [cfg.ansemMint] : [])];
  for (const mintStr of mints) {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mintStr), walletPk, true);
    let sigs;
    try {
      sigs = await connection.getSignaturesForAddress(ata, { limit: 25 });
    } catch { continue; } // ATA may not exist yet
    for (const s of sigs.reverse()) {
      if (s.err || seenSigs.includes(s.signature)) continue;
      seenSigs.push(s.signature);
      let parsed;
      try {
        parsed = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      } catch { continue; }
      const memo = memoOf(parsed);
      const { amount, payer } = receivedDelta(parsed, mintStr);
      if (!memo || !payer || amount <= 0) continue;
      const usdReceived = mintStr === cfg.usdcMint ? amount : amount / cfg.ansemPerUsd;
      const refund = (usd: number, ref: string, reason: string) => {
        if (usd >= 0.5) queuePayout({ kind: "usdc", to: payer, amountUsd: +usd.toFixed(2), raffleId: ref, reason });
      };

      const tix = memo.match(/^NERD:TICKETS:([a-f0-9]+):(\d+)$/);
      const cap = memo.match(/^NERD:CAPSULE:([a-f0-9]+):(\d+)$/);
      const mkt = memo.match(/^NERD:MKT:([a-f0-9]+)$/);

      if (tix) {
        const [, raffleId, claimedN] = tix;
        const r = state.raffles.find((x) => x.id === raffleId);
        if (!r || r.kind !== "paid" || r.status !== "open") {
          refund(usdReceived, raffleId, "raffle not open — full refund");
          continue;
        }
        // a paper-era raffle has no on-chain commit and no card behind it
        if (!isReal(r)) {
          refund(usdReceived, raffleId, "demo raffle — refunded, never chargeable");
          log.warn("pay", `payment hit a paper-mode raffle ${r.id} — refunded`);
          continue;
        }
        // credit from money received, never from the memo's claim
        const left = r.tickets - r.sold.reduce((x, t) => x + t.n, 0);
        const n = Math.min(left, Math.floor(usdReceived / r.ticketUsd + 0.001));
        if (n > 0) {
          r.sold.push({ buyer: payer, n, paidUsd: +(n * r.ticketUsd).toFixed(2), at: Date.now() });
          ledger("ticket-buy", { raffle: r.id, buyer: payer, n, paidUsd: +(n * r.ticketUsd).toFixed(2), sig: s.signature, claimedN: Number(claimedN), currency: mintStr === cfg.usdcMint ? "USDC" : "ANSEM" });
          log.info("pay", `${payer.slice(0, 8)} bought ${n} ticket(s) in ${r.id} (${s.signature.slice(0, 12)}…)`);
        }
        refund(usdReceived - n * r.ticketUsd, r.id, n === 0 ? "sold out — full refund" : "overpayment change");
      } else if (cap) {
        const [, machineId, claimedN] = cap;
        const m = state.machines.find((x) => x.id === machineId);
        if (!m || m.status !== "open") {
          refund(usdReceived, machineId, "machine closed — full refund");
          continue;
        }
        if (!isReal(m)) {
          refund(usdReceived, machineId, "demo machine — refunded, never chargeable");
          log.warn("pay", `payment hit a paper-mode machine ${m.id} — refunded`);
          continue;
        }
        // the price floats, so the payment itself is the budget: open as
        // many capsules as it buys at the live price, refund the rest
        const n = Math.max(1, Math.min(Number(claimedN) || 1, 25));
        // the payment tx is the entropy: its sig + its confirmation slot's blockhash
        let bh: string;
        try {
          bh = await blockhashOfSlot(s.slot);
        } catch {
          seenSigs = seenSigs.filter((x) => x !== s.signature); // retry next tick
          continue;
        }
        const res = await openCapsules(machineId, payer, n, { txSig: s.signature, slot: s.slot, blockhash: bh }, usdReceived);
        const spent = res.ok ? res.spentUsd! : 0;
        refund(usdReceived - spent, machineId, res.ok ? "unspent — change" : "could not open — full refund");
      } else if (mkt) {
        const [, listingId] = mkt;
        const l = state.market.find((x) => x.id === listingId);
        const gross = l ? +(l.n * l.priceUsd).toFixed(2) : 0;
        if (!l || l.status !== "open" || usdReceived + 0.01 < gross) {
          refund(usdReceived, listingId, "listing gone or underpaid — full refund");
          continue;
        }
        const res = fillListing(listingId, payer);
        if (!res.ok) { refund(usdReceived, listingId, `fill failed (${res.why}) — full refund`); continue; }
        ledger("market-fill-paid", { listing: listingId, buyer: payer, sig: s.signature, gross });
        refund(usdReceived - gross, listingId, "overpayment change");
      } else {
        continue; // unrelated transfer (buys, payouts, dust)
      }
      save();
    }
  }
  persistSigs();
}
