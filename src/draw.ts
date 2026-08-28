import crypto from "node:crypto";
import { connection as conn } from "./wallet.js";

/**
 * The fair-dice machinery.
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

// NOTE: this module used to build its own Connection from process.env.RPC_URL
// directly, bypassing config entirely — so every repair config makes (empty
// value, missing scheme, a bare Helius key) was undone here and the app still
// crashed on boot. Config is the ONLY place that reads chain env vars now;
// everything shares the one connection from wallet.ts.

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

/** Rejection-sampled unbiased index in [0, total) from arbitrary input. */
function sampleIndex(input: string, total: number): number {
  if (total <= 0) throw new Error("empty pool");
  let h = crypto.createHash("sha256").update(input).digest();
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

/** Deterministic unbiased winner: index in [0, total). */
export function winningIndex(seed: string, blockhash: string, total: number): number {
  return sampleIndex(`${seed}|${blockhash}`, total);
}

/**
 * Instant-open draw for capsule machines: neither side can steer it.
 * The buyer's tx signature is fixed before the blockhash of its
 * confirmation slot exists; the machine controls neither.
 */
export function openIndex(machineId: string, txSig: string, blockhash: string, remaining: number): number {
  return sampleIndex(`${machineId}|${txSig}|${blockhash}`, remaining);
}

/** Latest confirmed block — entropy source for paper-mode capsule opens.
 *  Cached 4s: burst opens shouldn't hammer the RPC (paper-only path; live
 *  entropy comes from each payment tx's own confirmation slot). */
let lastBlockCache: { at: number; v: { slot: number; blockhash: string } } | undefined;
export async function latestBlock(): Promise<{ slot: number; blockhash: string }> {
  if (lastBlockCache && Date.now() - lastBlockCache.at < 4000) return lastBlockCache.v;
  const v = await latestBlockFresh();
  lastBlockCache = { at: Date.now(), v };
  return v;
}
async function latestBlockFresh(): Promise<{ slot: number; blockhash: string }> {
  const tip = await conn.getSlot("confirmed");
  for (let s = tip; s > tip - 20; s--) {
    try {
      const b = await conn.getBlock(s, { maxSupportedTransactionVersion: 0, transactionDetails: "none", rewards: false });
      if (b?.blockhash) return { slot: s, blockhash: b.blockhash };
    } catch { /* walk back */ }
  }
  throw new Error("no recent confirmed block found");
}

/** Blockhash of a specific slot (walks FORWARD past skipped slots). */
export async function blockhashOfSlot(slot: number): Promise<string> {
  return (await blockhashAtOrAfter(slot)).blockhash;
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
