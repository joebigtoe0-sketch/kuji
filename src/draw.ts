import crypto from "node:crypto";
import { Connection } from "@solana/web3.js";

/**
 * The fair-dice machinery — the same doctrine as RIKU's trade commitments.
 *
 * COMMIT (before any ticket sells):
 *   commitHash = sha256(manifestJson | secretSeed | resolveSlot)
 * The resolve slot is a FUTURE Solana slot named inside the commitment — the
 * house cannot grind seeds against a blockhash that does not exist yet.
 *
 * RESOLVE (after the slot passes):
 *   rand = sha256(secretSeed | blockhash(resolveSlot))
 * The winning ticket index = rand mod totalTickets (rejection-sampled so the
 * modulo is unbiased). Everything republished; anyone can recompute.
 *
 * Paper mode uses REAL mainnet blockhashes — the verify path is production
 * grade even while the money is fake.
 */

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");

export function makeSeed(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function commitHash(manifestJson: string, seed: string, resolveSlot: number): string {
  return crypto.createHash("sha256").update(`${manifestJson}|${seed}|${resolveSlot}`).digest("hex");
}

export async function currentSlot(): Promise<number> {
  return conn.getSlot("confirmed");
}

/** Blockhash of the named slot (walks forward past skipped slots — the rule,
 *  stated in the commitment, is "first available block at or after S"). */
export async function blockhashAtOrAfter(slot: number, maxWalk = 50): Promise<{ slot: number; blockhash: string }> {
  for (let s = slot; s < slot + maxWalk; s++) {
    try {
      const b = await conn.getBlock(s, { maxSupportedTransactionVersion: 0, transactionDetails: "none", rewards: false });
      if (b?.blockhash) return { slot: s, blockhash: b.blockhash };
    } catch { /* skipped slot — walk on */ }
  }
  throw new Error(`no block found in [${slot}, ${slot + maxWalk})`);
}

/** Deterministic unbiased winner: index in [0, total). */
export function winningIndex(seed: string, blockhash: string, total: number): number {
  if (total <= 0) throw new Error("no tickets");
  // rejection sampling over 8-byte windows of repeated hashing — unbiased mod
  let h = crypto.createHash("sha256").update(`${seed}|${blockhash}`).digest();
  const max = 2n ** 64n;
  const limit = max - (max % BigInt(total));
  for (;;) {
    for (let off = 0; off + 8 <= h.length; off += 8) {
      const v = h.readBigUInt64BE(off);
      if (v < limit) return Number(v % BigInt(total));
    }
    h = crypto.createHash("sha256").update(h).digest();
  }
}

/** Full independent verification of a resolved draw. */
export function verify(opts: {
  manifestJson: string;
  seed: string;
  resolveSlot: number;
  commitHash: string;
  blockhash: string;
  total: number;
  claimedWinnerIndex: number;
}): { ok: boolean; why?: string } {
  const h = commitHash(opts.manifestJson, opts.seed, opts.resolveSlot);
  if (h !== opts.commitHash) return { ok: false, why: "commit hash does not match manifest|seed|slot" };
  const idx = winningIndex(opts.seed, opts.blockhash, opts.total);
  if (idx !== opts.claimedWinnerIndex) return { ok: false, why: `recomputed winner ${idx} != claimed ${opts.claimedWinnerIndex}` };
  return { ok: true };
}
