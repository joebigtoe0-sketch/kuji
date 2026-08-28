import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { cfg } from "./config.js";
import { connection, walletPk } from "./wallet.js";
import { log } from "./log.js";

/**
 * Live holder snapshots for the free holder raffles. Entries are weighted
 * by token balance, and holding $ANSEM multiplies that weight.
 *
 * Reading every holder of a mint is the awkward part:
 *   1. Helius DAS `getTokenAccounts` — purpose-built, paginated, reliable.
 *      Used whenever a DAS endpoint is available.
 *   2. `getProgramAccounts` with a mint filter — the standard fallback.
 *      Public RPCs often refuse it outright, and it must be run against
 *      BOTH token programs: a Token-2022 mint has a different owner
 *      program and a different account size, so filtering only classic
 *      SPL silently returns zero holders for a perfectly healthy token.
 *
 * Excluded: the machine's own wallet and EXCLUDE_WALLETS (AMM pools, the
 * deployer — anything that should not win its own raffle).
 */

const excluded = new Set(
  (process.env.EXCLUDE_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

interface Holder { wallet: string; balance: number }

function dasEndpoint(): string {
  if (cfg.dasUrl) return cfg.dasUrl;
  if (cfg.rpcUrl.includes("helius")) return cfg.rpcUrl;
  return "";
}

/** Helius DAS: list every token account for a mint, paginated. */
async function viaDas(mint: string): Promise<Map<string, number> | null> {
  const url = dasEndpoint();
  if (!url) return null;
  const out = new Map<string, number>();
  let cursor: string | undefined;
  for (let page = 0; page < 40; page++) {
    const body: any = { jsonrpc: "2.0", id: 1, method: "getTokenAccounts", params: { mint, limit: 1000, options: { showZeroBalance: false } } };
    if (cursor) body.params.cursor = cursor;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j: any = await res.json();
    if (j.error) throw new Error(`DAS getTokenAccounts: ${JSON.stringify(j.error).slice(0, 120)}`);
    const rows = j.result?.token_accounts ?? [];
    for (const a of rows) {
      const owner = String(a.owner ?? "");
      const raw = Number(a.amount ?? 0);
      if (owner && raw > 0) out.set(owner, (out.get(owner) ?? 0) + raw);
    }
    cursor = j.result?.cursor;
    if (!cursor || !rows.length) break;
  }
  // DAS returns raw amounts — scale by the mint's decimals
  const dec = await mintDecimals(mint);
  const scale = 10 ** dec;
  for (const [k, v] of out) out.set(k, v / scale);
  return out;
}

async function mintDecimals(mint: string): Promise<number> {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    return Number((info.value?.data as any)?.parsed?.info?.decimals ?? 0);
  } catch { return 0; }
}

/** Fallback: scan token accounts directly, across BOTH token programs. */
async function viaProgramAccounts(mint: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const programs = [
    { id: TOKEN_PROGRAM_ID, size: 165 },
    { id: TOKEN_2022_PROGRAM_ID, size: 165 }, // 2022 accounts are >= 165; dataSize filter omitted below
  ];
  let lastErr: unknown;
  let anyOk = false;
  for (const p of programs) {
    try {
      const accounts = await connection.getParsedProgramAccounts(p.id, {
        filters: [{ memcmp: { offset: 0, bytes: new PublicKey(mint).toBase58() } }],
      });
      anyOk = true;
      for (const a of accounts) {
        const info = (a.account.data as any)?.parsed?.info;
        const owner = String(info?.owner ?? "");
        const bal = Number(info?.tokenAmount?.uiAmount ?? 0);
        if (owner && bal > 0) out.set(owner, (out.get(owner) ?? 0) + bal);
      }
    } catch (e) { lastErr = e; }
  }
  if (!anyOk) throw lastErr ?? new Error("getProgramAccounts failed on both token programs");
  return out;
}

async function balancesByOwner(mint: string): Promise<Map<string, number>> {
  try {
    const das = await viaDas(mint);
    if (das) return das;
  } catch (e) {
    log.warn("holders", `DAS holder read failed, falling back: ${String(e).slice(0, 100)}`);
  }
  return viaProgramAccounts(mint);
}

let cache: { at: number; holders: Holder[] } | undefined;

/** Balance-weighted holder list, ANSEM boost applied. Cached 5 min. */
export async function snapshotHolders(): Promise<Holder[]> {
  return (await holderReport()).holders;
}

/**
 * The same snapshot, but with the REASON when it comes back empty —
 * "no holders" and "the RPC refused the query" need different fixes and
 * used to be reported identically.
 */
export async function holderReport(): Promise<{ holders: Holder[]; why?: string; raw?: number }> {
  if (!cfg.live) return { holders: [], why: "paper mode — holder snapshots only run live" };
  if (!cfg.tokenMint) return { holders: [], why: "no token mint set. Paste the token CA in the settings above." };
  if (cache && Date.now() - cache.at < 5 * 60_000) return { holders: cache.holders };
  let token: Map<string, number>;
  try {
    token = await balancesByOwner(cfg.tokenMint);
  } catch (e) {
    return { holders: [], why: `could not read holders from the RPC: ${String(e).slice(0, 160)}` };
  }
  const ansem = cfg.ansemMint ? await balancesByOwner(cfg.ansemMint).catch(() => new Map<string, number>()) : new Map<string, number>();
  const holders: Holder[] = [];
  for (const [wallet, balance] of token) {
    if (wallet === walletPk.toBase58() || excluded.has(wallet)) continue;
    const boosted = (ansem.get(wallet) ?? 0) >= cfg.ansemMinUsd ? balance * cfg.ansemBoost : balance;
    holders.push({ wallet, balance: boosted });
  }
  cache = { at: Date.now(), holders };
  log.info("holders", `snapshot: ${holders.length} holders (${token.size} raw)`);
  if (!holders.length) {
    return {
      holders, raw: token.size,
      why: token.size === 0
        ? "the mint has no token accounts with a balance — is the token actually launched, and is the CA correct?"
        : `found ${token.size} token account(s), but all were excluded (the machine's own wallet, or EXCLUDE_WALLETS)`,
    };
  }
  return { holders, raw: token.size };
}
