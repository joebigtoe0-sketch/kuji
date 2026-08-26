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

/** Build the unsigned payment tx for the buy widget. */
export async function buildPayTx(raffleId: string, n: number, payer: string, currency: "usdc" | "ansem" = "usdc"): Promise<{ ok: boolean; tx?: string; why?: string }> {
  const r = state.raffles.find((x) => x.id === raffleId);
  if (!r || r.status !== "open" || r.kind !== "paid") return { ok: false, why: "no open paid raffle" };
  const left = r.tickets - r.sold.reduce((s, t) => s + t.n, 0);
  if (n < 1 || n > left) return { ok: false, why: `only ${left} tickets left` };

  const useAnsem = currency === "ansem" && !!cfg.ansemMint && cfg.ansemPerUsd > 0;
  const mint = new PublicKey(useAnsem ? cfg.ansemMint : cfg.usdcMint);
  const dec = (await getMint(connection, mint)).decimals;
  const usd = +(n * r.ticketUsd).toFixed(2);
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
      data: Buffer.from(`NERD:TICKETS:${raffleId}:${n}`, "utf8"),
    }),
  );
  tx.feePayer = payerPk;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  return { ok: true, tx: tx.serialize({ requireAllSignatures: false }).toString("base64") };
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
      const m = memo?.match(/^NERD:TICKETS:([a-f0-9]+):(\d+)$/);
      if (!m) continue; // not a ticket payment (buys, payouts, dust)
      const [, raffleId, claimedN] = m;
      const { amount, payer } = receivedDelta(parsed, mintStr);
      if (!payer || amount <= 0) continue;

      const r = state.raffles.find((x) => x.id === raffleId);
      const usdReceived = mintStr === cfg.usdcMint ? amount : amount / cfg.ansemPerUsd;
      if (!r || r.kind !== "paid" || r.status !== "open") {
        queuePayout({ kind: "usdc", to: payer, amountUsd: +usdReceived.toFixed(2), raffleId: raffleId, reason: "raffle not open — full refund" });
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
      const excess = +(usdReceived - n * r.ticketUsd).toFixed(2);
      if (excess >= 0.5) // ignore sub-50¢ dust — refund tx fees would eat it
        queuePayout({ kind: "usdc", to: payer, amountUsd: excess, raffleId: r.id, reason: n === 0 ? "sold out — full refund" : "overpayment change" });
      save();
    }
  }
  persistSigs();
}
