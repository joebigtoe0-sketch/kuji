import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { cfg } from "./config.js";
import { connection, walletPk } from "./wallet.js";
import { log } from "./log.js";

/**
 * Live holder snapshots for the free holder raffles. Entries are weighted
 * by token balance, and holding $ANSEM multiplies your weight (the ANSEM
 * utility hook). Uses getProgramAccounts with a mint filter — fine on a
 * real RPC (Helius etc.); public mainnet RPC may refuse it, which is why
 * RPC_URL is a first-class knob.
 *
 * Excluded from snapshots: the machine's own wallet and EXCLUDE_WALLETS
 * (AMM pools, the deployer, etc. — anything that shouldn't win its own
 * raffle).
 */

const excluded = new Set(
  (process.env.EXCLUDE_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

interface Holder { wallet: string; balance: number }

async function balancesByOwner(mint: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const accounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: new PublicKey(mint).toBase58() } }],
  });
  for (const a of accounts) {
    const info = (a.account.data as any)?.parsed?.info;
    const owner = String(info?.owner ?? "");
    const bal = Number(info?.tokenAmount?.uiAmount ?? 0);
    if (!owner || bal <= 0) continue;
    out.set(owner, (out.get(owner) ?? 0) + bal);
  }
  return out;
}

let cache: { at: number; holders: Holder[] } | undefined;

/** Balance-weighted holder list, ANSEM boost applied. Cached 5 min. */
export async function snapshotHolders(): Promise<Holder[]> {
  if (!cfg.live || !cfg.tokenMint) return [];
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.holders;
  try {
    const token = await balancesByOwner(cfg.tokenMint);
    const ansem = cfg.ansemMint ? await balancesByOwner(cfg.ansemMint) : new Map<string, number>();
    const holders: Holder[] = [];
    for (const [wallet, balance] of token) {
      if (wallet === walletPk.toBase58() || excluded.has(wallet)) continue;
      const boosted = (ansem.get(wallet) ?? 0) >= cfg.ansemMinUsd ? balance * cfg.ansemBoost : balance;
      holders.push({ wallet, balance: boosted });
    }
    cache = { at: Date.now(), holders };
    log.info("holders", `snapshot: ${holders.length} holders (${[...token.keys()].length} raw, ${holders.filter((h) => (ansem.get(h.wallet) ?? 0) >= cfg.ansemMinUsd).length} ANSEM-boosted)`);
    return holders;
  } catch (e) {
    log.warn("holders", `snapshot failed: ${String(e).slice(0, 120)} — holder raffles paused this tick`);
    return cache?.holders ?? [];
  }
}
