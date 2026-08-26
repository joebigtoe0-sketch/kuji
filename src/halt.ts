import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";
import { log } from "./log.js";

/**
 * Kill switch. A HALT file in data/ stops everything that spends or moves:
 * sniping, buying, payouts, new raffles. Reading a raffle page still works —
 * the machine goes read-only, it doesn't go dark. Toggled via
 * /api/admin/halt (ADMIN_KEY) or by hand: `touch data/HALT`.
 */

const FILE = path.join(cfg.dataDir, "HALT");

export function halted(): boolean {
  return fs.existsSync(FILE);
}

export function setHalt(on: boolean, why = ""): void {
  if (on) {
    fs.writeFileSync(FILE, `halted ${new Date().toISOString()} ${why}\n`);
    log.warn("halt", `MACHINE HALTED ${why}`);
  } else if (halted()) {
    fs.unlinkSync(FILE);
    log.info("halt", "machine resumed");
  }
}
