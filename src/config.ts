import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const bool = (k: string, def: boolean) =>
  (process.env[k] ?? String(def)).toLowerCase() === "true";

const envLive = bool("LIVE_MODE", false);
const devnet = bool("DEVNET", false);

const num = (k: string, def: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : def;
};
/**
 * An env var that exists but is EMPTY counts as unset.
 *
 * `??` only falls back on undefined, so a variable added in a dashboard and
 * left blank used to pass "" straight through — which crashed the app on
 * boot when it reached `new Connection("")`. Blank means "not configured".
 */
const str = (k: string, def = "") => {
  const v = (process.env[k] ?? "").trim();
  return v || def;
};

/** A URL-shaped setting: repair a missing scheme, reject anything unusable. */
const url = (k: string, def: string) => {
  const v = str(k);
  if (!v) return def;
  // A bare Helius API key is an easy thing to paste here. On its own it would
  // pass URL validation as the hostname "https://<uuid>" and then fail every
  // request with DNS errors, so expand it into the real endpoint instead.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    const host = devnet ? "devnet.helius-rpc.com" : "mainnet.helius-rpc.com";
    console.warn(`[config] ${k} looked like a bare Helius key — using https://${host}/?api-key=…`);
    return `https://${host}/?api-key=${v}`;
  }
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    new URL(withScheme);
    return withScheme;
  } catch {
    console.warn(`[config] ${k}="${v}" is not a usable URL — falling back to ${def}`);
    return def;
  }
};

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });

/**
 * Runtime settings (admin panel) — override env, survive restarts.
 * The live toggle lives here: flipping it switches the machine to real
 * mainnet operation from that moment, no restart needed.
 */
interface Runtime { live?: boolean; tokenMint?: string; xUrl?: string; bootstrap?: boolean }
const RUNTIME_FILE = path.join(dataDir, "settings.json");
const runtime: Runtime = (() => {
  try { return JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8")); } catch { return {}; }
})();
export function setRuntime(patch: Runtime): Runtime {
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (runtime as any)[k] = v;
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 1));
  return { ...runtime };
}
export const getRuntime = (): Runtime => ({ ...runtime });

export const cfg = {
  root,
  dataDir,
  port: num("PORT", 8630),
  /** paper = simulation with receipts. live = real chain. Never both. */
  get live() { return runtime.live ?? envLive; },
  get paper() { return !(runtime.live ?? envLive); },
  devnet,
  paperBudget: num("PAPER_BUDGET", 500),

  // chain
  rpcUrl: url("RPC_URL", devnet ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com"),
  usdcMint: str("USDC_MINT", devnet
    ? "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr" // USDC-Dev — what CC devnet actually trades in (mintable by anyone via the spl-token-faucet program)
    : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  get tokenMint() { return runtime.tokenMint ?? str("TOKEN_MINT"); }, // our launched token (CA) — admin-settable
  get xUrl() { return runtime.xUrl ?? str("X_URL"); }, // the project's X profile — admin-settable
  ansemMint: str("ANSEM_MINT"), // $ANSEM — holder-raffle weight boost + ticket currency
  ansemBoost: num("ANSEM_BOOST", 1.5), // holder-raffle entry multiplier for ANSEM holders
  ansemMinUsd: num("ANSEM_MIN", 10), // min ANSEM (ui amount) to qualify for the boost
  ansemPerUsd: num("ANSEM_PER_USD", 0), // ANSEM accepted for tickets at this rate (0 = USDC only)
  walletSecret: str("WALLET_SECRET"), // base58 or JSON byte array; empty → keypair generated to data/
  dasUrl: url("DAS_URL", ""), // DAS-capable RPC (Helius) — required for compressed-NFT ownership/transfers; falls back to RPC_URL if that's Helius
  adminKey: str("ADMIN_KEY"), // guards /api/admin/* in live mode

  // live guardrails (on top of the paper-era sniper guardrails)
  liveMaxCardUsd: num("LIVE_MAX_CARD_USD", 50), // hard per-card cap for real buys

  /**
   * Bootstrap mode (admin-toggleable, ON by default): at launch, inventory
   * beats edge — cheap cards clear a relaxed edge bar so the vault stocks
   * up in days instead of weeks.
   *
   * (There used to be a "junk" tier that bought sub-$3 cards as capsule
   * filler. Deleted 2026-08-27: a market scan of all 4000 live listings
   * found NOTHING under $2 and only 17 listings under $5 — graded+vaulted
   * cards have a hard floor near $13 because grading alone costs more than
   * that. The card basket already does the filler job.)
   */
  get bootstrap() { return runtime.bootstrap ?? bool("BOOTSTRAP", true); },
  bootstrapMinEdge: num("BOOTSTRAP_MIN_EDGE", 0.05), // relaxed bar for cheap cards
  bootstrapMaxCardUsd: num("BOOTSTRAP_MAX_CARD_USD", 40), // "cheap" = up to this
  payWatchEverySec: num("PAY_WATCH_EVERY_SEC", 20),

  // sniper
  minEdge: num("MIN_EDGE", 0.15),
  maxEdge: num("MAX_EDGE", 0.45), // beyond this it's a comp error until a human agrees
  maxBuysPerSweep: num("MAX_BUYS_PER_SWEEP", 3),
  maxPerCardFrac: num("MAX_PER_CARD_FRAC", 0.25), // one card never exceeds this share of the wallet
  compHaircut: num("COMP_HAIRCUT", 0.9),
  minComps: num("MIN_COMPS", 3),
  priceMin: num("PRICE_MIN", 20),
  priceMax: num("PRICE_MAX", 400),
  scanPages: num("SCAN_PAGES", 30),
  scanEveryMin: num("SCAN_EVERY_MIN", 10),
  categories: str("CATEGORIES", "Pokemon,One Piece,Magic The Gathering,Lorcana,Dragon Ball,Riftbound")
    .split(",").map((s) => s.trim()).filter(Boolean),

  gradeAfterH: num("GRADE_AFTER_H", 24),

  // capsule machines
  capsuleUsd: num("CAPSULE_USD", 1),
  /**
   * No single card may exceed this share of a machine's rack. With a
   * floating price the house earns the snipe spread on average whatever
   * this is — but concentration drives the SWING. Measured on a $210 pool:
   * one 20% chase = ±$40 and 47% losing machines; the same card value split
   * across six 3% cards = ±$15 and 17%; fourteen 1.5% cards = ±$8 and 2%.
   */
  maxCardShare: num("MAX_CARD_SHARE", 0.08),
  cardsPerMachine: num("CARDS_PER_MACHINE", 8), // basket size — diversification is free variance reduction
  minCardsPerMachine: num("MIN_CARDS_PER_MACHINE", 3), // below this, wait for stock rather than build a coin-flip
  machineMaxCardUsd: num("MACHINE_MAX_CARD_USD", 150), // bigger cards go to raffles instead

  // raffles
  ticketsMin: num("TICKETS_MIN", 10),
  ticketsMax: num("TICKETS_MAX", 25),
  raffleFillHours: num("RAFFLE_FILL_HOURS", 48),
  holderRaffleShare: num("HOLDER_RAFFLE_SHARE", 0.5),
  maxOpenRaffles: num("MAX_OPEN_RAFFLES", 2),
  resolveDelayMin: num("RESOLVE_DELAY_MIN", 30), // draw slot this long after the fill window

  // local demo: simulated ticket buyers + holders so the lifecycle runs alone
  simBuyers: (process.env.SIM_BUYERS ?? "true").toLowerCase() === "true",
  simBuyEverySec: num("SIM_BUY_EVERY_SEC", 45),
};
