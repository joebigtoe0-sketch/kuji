import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { cfg } from "./config.js";
import { sendTx, walletPk } from "./wallet.js";
import { ledger } from "./store.js";
import { log } from "./log.js";

/**
 * On-chain anchoring of the fairness scheme (LIVE_MODE). The commit hash
 * goes into a Memo transaction BEFORE any ticket can sell, so "the odds
 * were fixed in advance" is provable from the chain, not from our logs.
 * The reveal memo closes the loop after the draw. Paper mode logs what it
 * would have published.
 */

const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: walletPk, isSigner: true, isWritable: false }],
    programId: MEMO,
    data: Buffer.from(text, "utf8"),
  });
}

export async function publishCommit(id: string, hash: string, resolveSlot: number): Promise<string | undefined> {
  const text = `NERD:COMMIT:${id}:${hash}:${resolveSlot}`;
  if (!cfg.live) {
    ledger("commit-paper", { raffle: id, memo: text, note: "live mode would publish this memo on-chain" });
    return undefined;
  }
  try {
    const sig = await sendTx([memoIx(text)], `commit ${id}`);
    ledger("commit-onchain", { raffle: id, sig, memo: text });
    return sig;
  } catch (e) {
    // a raffle without an on-chain commit must not open in live mode
    log.warn("commit", `publish failed for ${id}: ${String(e).slice(0, 120)}`);
    throw e;
  }
}

export async function publishReveal(id: string, seed: string, blockhash: string, winnerIndex: number): Promise<string | undefined> {
  const text = `NERD:REVEAL:${id}:${seed}:${blockhash}:${winnerIndex}`;
  if (!cfg.live) return undefined;
  try {
    const sig = await sendTx([memoIx(text)], `reveal ${id}`);
    ledger("reveal-onchain", { raffle: id, sig });
    return sig;
  } catch (e) {
    // non-fatal: the seed is already revealed in the ledger + API
    log.warn("commit", `reveal publish failed for ${id}: ${String(e).slice(0, 120)}`);
    return undefined;
  }
}
