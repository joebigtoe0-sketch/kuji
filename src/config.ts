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

const dataDir = path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const cfg = {
  root,
  dataDir,
  port: num("PORT", 8630),
  paper: true, // PAPER MODE — nothing on chain moves. The whole point of v0.
  paperBudget: num("PAPER_BUDGET", 500),

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
