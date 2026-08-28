import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

const num = (k: string, def: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : def;
};
const str = (k: string, def = "") => process.env[k] ?? def;

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });

const bool = (k: string, def: boolean) =>
  (process.env[k] ?? String(def)).toLowerCase() === "true";

const envLive = bool("LIVE_MODE", false);
const devnet = bool("DEVNET", false);

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
  rpcUrl: str("RPC_URL", devnet ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com"),
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
  dasUrl: str("DAS_URL"), // DAS-capable RPC (Helius) — required for compressed-NFT ownership/transfers; falls back to RPC_URL if that's Helius
  adminKey: str("ADMIN_KEY"), // guards /api/admin/* in live mode

  // live guardrails (on top of the paper-era sniper guardrails)
  liveMaxCardUsd: num("LIVE_MAX_CARD_USD", 50), // hard per-card cap for real buys

  /**
   * Bootstrap mode (admin-toggleable, ON by default): at launch, inventory
   * beats edge. Cheap cards buy on a relaxed edge bar, and penny "junk"
   * cards buy with NO edge requirement at all — they're capsule filler,
   * valued at exactly what they cost (still zero-edge).
   */
  get bootstrap() { return runtime.bootstrap ?? bool("BOOTSTRAP", true); },
  bootstrapMinEdge: num("BOOTSTRAP_MIN_EDGE", 0.05), // relaxed bar for cheap cards
  bootstrapMaxCardUsd: num("BOOTSTRAP_MAX_CARD_USD", 40), // "cheap" = up to this
  junkMaxUsd: num("JUNK_MAX_USD", 3), // junk tier: capsule-filler cards
  junkTarget: num("JUNK_TARGET", 30), // keep this many junk cards on hand
  junkBuysPerSweep: num("JUNK_BUYS_PER_SWEEP", 5),
  junkPerMachine: num("JUNK_PER_MACHINE", 12), // junk cards stuffed into each machine
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
   * No single card may exceed this share of a machine's pool. A pool one
   * prize can dominate is the negative-EV trap: the jackpot always ships
   * while only half the capsules sell. Keep it flat and it sells through.
   */
  maxCardShare: num("MAX_CARD_SHARE", 0.2),
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
