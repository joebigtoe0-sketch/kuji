import crypto from "node:crypto";
import { cfg } from "./config.js";
import { state, save, ledger, type Machine, type Prize, type VaultCard } from "./store.js";
import { openIndex, latestBlock } from "./draw.js";
import { publishCommit } from "./commitchain.js";
import { queuePayout } from "./payouts.js";
import { suspectComp } from "./raffles.js";
import { halted } from "./halt.js";
import { log } from "./log.js";

/**
 * Capsule machines — the candy-machine mechanic, zero-edge edition.
 *
 * A sniped card becomes the headline prize of a machine of N $1 capsules.
 * The rest of the pool is cash envelopes. sum(all prizes) == N * price,
 * EXACTLY — buy every capsule and you get your money back in value. The
 * machine's profit was earned at the snipe, never at the counter.
 *
 * The prize TABLE is public from minute one (that's the fun — you can see
 * the card sitting in the pool and count what's left, exactly like a real
 * ichiban kuji rack). WHICH capsule holds what doesn't exist yet: every
 * open draws uniformly from the remaining pool via
 * sha256(machineId | buyerTxSig | blockhash(confirmSlot)). The buyer's
 * signature is fixed before that blockhash exists; we control neither.
 *
 * THE ROLLOVER RULE (in the manifest): when the headline card pops, the
 * machine closes and every unclaimed cash envelope rolls into the next
 * machine's pool. The house never keeps an unclaimed envelope — a stalled
 * cash-only machine can't quietly become house profit.
 */

export function machineManifest(m: Machine): string {
  return JSON.stringify({
    id: m.id, headline: m.nft, capsules: m.capsules, priceUsd: m.priceUsd,
    prizes: m.prizes.map((p) => ({ kind: p.kind, nft: p.nft, valueUsd: p.valueUsd, label: p.label })),
    rolledInUsd: m.rolledInUsd,
    rules: [
      "each open: draw = sha256(machineId|txSig|blockhash of the open's confirmation slot), rejection-sampled over the REMAINING pool in original array order",
      "when the headline card is claimed the machine closes; unclaimed cash rolls into the next machine",
      "sum(prizes) == capsules * priceUsd + rolledInUsd — zero house edge",
    ],
  });
}

/**
 * Build an exact zero-edge prize table around a card.
 * cashTotal = capsules*price + rolledIn - comp, split into $5 / $1 / dime
 * tiers; the leftover cents land on one odd envelope so the sum is EXACT.
 */
function buildPrizes(card: VaultCard, capsules: number, priceUsd: number, rolledInUsd: number): Prize[] | null {
  const totalC = Math.round(capsules * priceUsd * 100) + Math.round(rolledInUsd * 100);
  let cashC = totalC - Math.round(card.compUsd * 100);
  const slots = capsules - 1; // every capsule holds something
  if (cashC < slots || slots < 1) return null; // can't give every envelope >= 1 cent
  const prizes: Prize[] = [{ kind: "card", nft: card.nft, valueUsd: card.compUsd, label: `THE CARD — ${card.itemName.slice(0, 60)}` }];
  const n5 = Math.min(Math.floor((cashC * 0.25) / 500), Math.max(0, slots - 2));
  const n1 = Math.min(Math.floor((cashC * 0.35) / 100), Math.max(0, slots - n5 - 1));
  const nDime = slots - n5 - n1;
  cashC -= n5 * 500 + n1 * 100;
  const dimeEach = Math.floor(cashC / nDime);
  let remainder = cashC - dimeEach * nDime;
  for (let i = 0; i < n5; i++) prizes.push({ kind: "cash", valueUsd: 5, label: "CASH $5" });
  for (let i = 0; i < n1; i++) prizes.push({ kind: "cash", valueUsd: 1, label: "CASH $1" });
  for (let i = 0; i < nDime; i++) {
    const cents = dimeEach + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    prizes.push({ kind: "cash", valueUsd: +(cents / 100).toFixed(2), label: `CASH ${cents}¢` });
  }
  // paranoia: the whole product is this invariant
  const sum = prizes.reduce((s, p) => s + Math.round(p.valueUsd * 100), 0);
  if (sum !== totalC) {
    log.warn("capsule", `prize table sum ${sum} != ${totalC} — refusing to build`);
    return null;
  }
  return prizes;
}

/** Keep one machine stocked from the vault (cheapest suitable card). */
export async function autoMachine(): Promise<void> {
  if (halted()) return;
  if (state.machines.some((m) => m.status === "open")) return;
  const card = state.vault
    .filter((v) => v.status === "vault" && !suspectComp(v) && v.compUsd <= cfg.machineMaxCardUsd)
    .sort((a, b) => a.compUsd - b.compUsd)[0];
  if (!card) return;
  await createMachine(card);
}

export async function createMachine(card: VaultCard): Promise<Machine | null> {
  const priceUsd = cfg.capsuleUsd;
  // card ≈ 60-70% of machine value → the pool feels alive but the card headlines
  const capsules = Math.ceil(card.compUsd / (priceUsd * cfg.machineCardShare));
  const rolledIn = state.rolloverUsd;
  const prizes = buildPrizes(card, capsules, priceUsd, rolledIn);
  if (!prizes) return null;
  const id = crypto.randomBytes(6).toString("hex");
  const m: Machine = {
    id, title: card.itemName, nft: card.nft, capsules, priceUsd, prizes,
    opens: [], commitHash: "", status: "open",
    rolledInUsd: rolledIn, createdAt: Date.now(),
  };
  m.commitHash = crypto.createHash("sha256").update(machineManifest(m)).digest("hex");
  m.commitSig = await publishCommit(id, m.commitHash, 0); // slot 0 = "no future slot; per-open entropy"
  state.rolloverUsd = 0;
  card.machineId = id;
  card.status = "machined";
  state.machines.push(m);
  save();
  ledger("machine-open", {
    id, nft: card.nft, item: card.itemName, capsules, priceUsd,
    cardValue: card.compUsd, cashValue: +(capsules * priceUsd + rolledIn - card.compUsd).toFixed(2),
    rolledInUsd: rolledIn, commit: m.commitHash,
  });
  log.info("capsule", `MACHINE ${id}: ${capsules} x $${priceUsd} — ${card.itemName.slice(0, 45)} ($${card.compUsd}) + cash${rolledIn ? ` (+$${rolledIn} rolled in)` : ""}`);
  return m;
}

/** Open capsules. txSig/slot/blockhash come from the payment tx in live mode. */
export async function openCapsules(
  machineId: string, buyer: string, n: number,
  entropy?: { txSig: string; slot: number; blockhash: string },
): Promise<{ ok: boolean; prizes?: Prize[]; why?: string }> {
  const m = state.machines.find((x) => x.id === machineId);
  if (!m || m.status !== "open") return { ok: false, why: "no open machine" };
  if (halted()) return { ok: false, why: "machine is paused" };
  const remainingIdx = () => m.prizes.map((_, i) => i).filter((i) => !m.prizes[i].claimedBy);
  let left = remainingIdx();
  n = Math.min(n, left.length);
  if (n < 1) return { ok: false, why: "machine is empty" };

  // paper mode manufactures a fake sig but uses a REAL chain blockhash
  const e = entropy ?? { txSig: "paper-" + crypto.randomBytes(24).toString("hex"), ...(await latestBlock()) };
  const won: Prize[] = [];
  for (let k = 0; k < n; k++) {
    left = remainingIdx();
    if (!left.length) break;
    // multi-capsule opens chain the draw: k is appended so each capsule
    // in one tx gets an independent draw, still fully recomputable
    const pick = left[openIndex(m.id, `${e.txSig}:${k}`, e.blockhash, left.length)];
    const prize = m.prizes[pick];
    prize.claimedBy = buyer;
    m.opens.push({ buyer, txSig: `${e.txSig}:${k}`, slot: e.slot, blockhash: e.blockhash, prizeIdx: pick, at: Date.now() });
    won.push(prize);
    if (!cfg.live) state.walletUsd += m.priceUsd;
    if (prize.kind === "cash") {
      if (cfg.live) queuePayout({ kind: "usdc", to: buyer, amountUsd: prize.valueUsd, raffleId: m.id, reason: `capsule prize ${prize.label}` });
      else state.walletUsd -= prize.valueUsd;
    } else if (cfg.live) {
      queuePayout({ kind: "nft", to: buyer, nft: prize.nft!, raffleId: m.id, reason: "capsule headline card" });
    }
    ledger("capsule-open", { machine: m.id, buyer, prize: prize.label, valueUsd: prize.valueUsd, txSig: `${e.txSig}:${k}`, slot: e.slot, blockhash: e.blockhash, prizeIdx: pick });
  }
  const cardPopped = won.some((p) => p.kind === "card");
  if (cardPopped || !remainingIdx().length) closeMachine(m, cardPopped ? "card claimed" : "sold out");
  save();
  if (cardPopped) log.info("capsule", `💥 HEADLINE CARD popped in ${m.id} → ${buyer}`);
  return { ok: true, prizes: won };
}

function closeMachine(m: Machine, why: string): void {
  m.status = "closed";
  m.closedAt = Date.now();
  const card = state.vault.find((v) => v.machineId === m.id);
  const winner = m.prizes.find((p) => p.kind === "card")?.claimedBy;
  if (card && winner) card.status = "awarded";
  const rollover = +m.prizes.filter((p) => !p.claimedBy).reduce((s, p) => s + p.valueUsd, 0).toFixed(2);
  m.rolledOutUsd = rollover;
  state.rolloverUsd = +(state.rolloverUsd + rollover).toFixed(2);
  const proceeds = m.opens.length * m.priceUsd;
  const cashPaid = m.prizes.filter((p) => p.claimedBy && p.kind === "cash").reduce((s, p) => s + p.valueUsd, 0);
  const profit = +(proceeds - cashPaid - rollover - (card?.paidUsd ?? 0)).toFixed(2);
  state.realizedProfitUsd = +(state.realizedProfitUsd + profit).toFixed(2);
  const toPool = +(Math.max(0, profit) * cfg.holderRaffleShare).toFixed(2);
  state.holderPoolUsd = +(state.holderPoolUsd + toPool).toFixed(2);
  if (!cfg.live) state.walletUsd -= toPool;
  ledger("machine-close", { machine: m.id, why, opens: m.opens.length, of: m.capsules, proceeds, cashPaid: +cashPaid.toFixed(2), rolledOutUsd: rollover, cardCost: card?.paidUsd, profit, toHolderPool: toPool });
  log.info("capsule", `CLOSED ${m.id} (${why}) — ${m.opens.length}/${m.capsules} opened, profit $${profit}, $${rollover} rolls over`);
}

/** Full independent verification of every open in a machine. */
export function verifyMachine(machineId: string): { ok: boolean; why?: string; opens?: number } {
  const m = state.machines.find((x) => x.id === machineId);
  if (!m) return { ok: false, why: "no such machine" };
  const hash = crypto.createHash("sha256").update(machineManifest(m)).digest("hex");
  if (hash !== m.commitHash) return { ok: false, why: "manifest hash mismatch" };
  const claimed = new Set<number>();
  for (const o of m.opens) {
    const left = m.prizes.map((_, i) => i).filter((i) => !claimed.has(i));
    const pick = left[openIndex(m.id, o.txSig, o.blockhash, left.length)];
    if (pick !== o.prizeIdx) return { ok: false, why: `open by ${o.buyer.slice(0, 8)}: recomputed prize ${pick} != recorded ${o.prizeIdx}` };
    claimed.add(pick);
  }
  return { ok: true, opens: m.opens.length };
}
