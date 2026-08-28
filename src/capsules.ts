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
 * Sniped cards become the prize pool of a machine of N $1 capsules, padded
 * with cash envelopes. sum(all prizes) == N * price, EXACTLY — buy every
 * capsule and you get your money back in value. The machine's profit was
 * earned at the snipe, never at the counter.
 *
 * The prize TABLE is public from minute one (that's the fun — you can see
 * the cards sitting in the pool and count what's left, exactly like a real
 * ichiban kuji rack). WHICH capsule holds what doesn't exist yet: every
 * open draws uniformly from the remaining pool via
 * sha256(machineId | buyerTxSig | blockhash(confirmSlot)). The buyer's
 * signature is fixed before that blockhash exists; we control neither.
 *
 * THE PRICE FLOATS — and this is the whole design, not a gimmick.
 *
 * A capsule costs exactly what the rack is worth right now:
 *     price = (value still in the rack) / (capsules still in the rack)
 *
 * Two earlier designs died here (2026-08-27) and the reason is worth
 * keeping: with a FIXED price and a public rack, buyers get a free option.
 * The rack starts worth exactly the price; every pull moves it — pull junk
 * and the rack becomes worth MORE than the price, pull the chase and it is
 * worth less. Rational buyers only play the favourable states and walk
 * away from the rest, and at zero house edge that option is paid for by
 * the house. Measured: buyers stop after ~47% of capsules and the machine
 * loses ~$6 per $210 pool. Closing the machine on the chase pull is worse
 * (-10%): the jackpot is then ALWAYS paid while half the rack never sells.
 *
 * Floating the price removes the option entirely. Every capsule is a fair
 * bet at the instant it is bought, so there is no moment worth waiting for
 * and no moment worth avoiding — the rack sells through. Over a machine
 * the house collects the sum of those fair prices and pays out the pool;
 * in expectation those cancel, and what is left over is exactly the snipe
 * spread on the cards. Per machine it swings either way (chase pulled
 * early = we collected little for a lot); across machines it is the
 * spread. That variance is the honest cost of a zero-edge gacha.
 *
 * Buyers see the price move live: pull the chase and the sign drops to
 * "capsules 77¢" in front of everyone.
 *
 * WHY EACH MACHINE HOLDS SEVERAL CARDS, NOT ONE BIG ONE: with a floating
 * price the house earns the snipe spread ON AVERAGE, but a single dominant
 * prize makes the per-machine swing enormous — if it pops early the price
 * collapses and we collect little for a lot. Measured on a $210 pool with
 * a $42 chase: mean +$14 (the spread, correct) but a $40 standard
 * deviation and 47% of machines losing money. Splitting the SAME $42 of
 * card value across six $7 cards keeps the mean at +$14 and cuts the
 * deviation to $15; across fourteen $3 cards it is $8 and only 2% of
 * machines lose. Same edge, a fraction of the risk — so machines are
 * built from a BASKET, and no single card may exceed maxCardShare.
 *
 * THE ROLLOVER RULE (in the manifest): if a machine is closed early with
 * capsules unsold, unclaimed cards return to the vault and unclaimed cash
 * rolls into the next machine. The house never keeps an envelope.
 */

/** Prizes still in the rack. */
export const remainingPrizes = (m: Machine): Prize[] => m.prizes.filter((p) => !p.claimedBy);

/**
 * THE LIVE PRICE: value still in the rack ÷ capsules still in the rack.
 * A capsule is therefore always a fair bet at the moment it is bought.
 */
export function capsulePrice(m: Machine): number {
  const left = remainingPrizes(m);
  if (!left.length) return 0;
  const value = left.reduce((s, p) => s + p.valueUsd, 0);
  return Math.max(0.01, +(value / left.length).toFixed(2));
}

/** What n capsules cost right now (each priced as the rack depletes). */
export function quote(m: Machine, n: number): { n: number; totalUsd: number; priceUsd: number } {
  const left = remainingPrizes(m);
  const take = Math.min(n, left.length);
  // drawing k of the remaining uniformly has expected value k × mean, so
  // one price for the whole batch is exactly fair — and it is the price
  // openCapsules() will charge, so the quote is never short by a cent
  const price = capsulePrice(m);
  return { n: take, totalUsd: +(take * price).toFixed(2), priceUsd: price };
}

export function machineManifest(m: Machine): string {
  return JSON.stringify({
    id: m.id, headline: m.nft, capsules: m.capsules, priceUsd: m.priceUsd,
    prizes: m.prizes.map((p) => ({ kind: p.kind, nft: p.nft, valueUsd: p.valueUsd, label: p.label })),
    rolledInUsd: m.rolledInUsd,
    rules: [
      "each open: draw = sha256(machineId|txSig|blockhash of the open's confirmation slot), rejection-sampled over the REMAINING pool in original array order",
      "price floats: a capsule always costs (value still in the rack) / (capsules still in the rack), so every capsule is a fair bet when bought",
      "the machine runs until every capsule is opened; no prize ends it early",
      "if it is ever closed with capsules unsold, unclaimed cards return to the vault and unclaimed cash rolls into the next machine",
      "sum(prizes) == capsules * startPriceUsd + rolledInUsd — zero house edge",
    ],
  });
}

/**
 * Build an exact zero-edge prize table: the card basket (chase first) +
 * cash envelopes. sum(prizes) == N*price + rolledIn, EXACTLY — leftover
 * cents land on one odd envelope.
 */
function buildPrizes(cards: VaultCard[], capsules: number, priceUsd: number, rolledInUsd: number): Prize[] | null {
  const totalC = Math.round(capsules * priceUsd * 100) + Math.round(rolledInUsd * 100);
  const cardsC = cards.reduce((s, c) => s + Math.round(c.compUsd * 100), 0);
  let cashC = totalC - cardsC;
  const slots = capsules - cards.length; // cash envelopes
  if (cashC < slots || slots < 1) return null;
  const prizes: Prize[] = cards.map((c, i) => ({
    kind: "card" as const, nft: c.nft, valueUsd: c.compUsd,
    label: `${i === 0 ? "THE CHASE" : "CARD"} — ${c.itemName.slice(0, 56)}`,
  }));
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

/** Keep one machine stocked from the vault — a BASKET of cards, not one. */
export async function autoMachine(): Promise<void> {
  if (halted()) return;
  if (state.machines.some((m) => m.status === "open")) return;
  const eligible = state.vault
    .filter((v) => v.status === "vault" && !suspectComp(v) && v.compUsd <= cfg.machineMaxCardUsd)
    .sort((a, b) => a.compUsd - b.compUsd);
  if (eligible.length < cfg.minCardsPerMachine) return; // wait for stock — a
  // one-card machine is the high-variance shape we are avoiding
  await createMachine(eligible.slice(0, cfg.cardsPerMachine));
}

export async function createMachine(basket: VaultCard[]): Promise<Machine | null> {
  if (!basket.length) return null;
  // THE RULE, enforced here and not only at the caller: a card whose edge
  // is too good to be true never sets a rack price. The rack price IS the
  // capsule price, so one bogus comp would overcharge every buyer.
  const suspect = basket.filter(suspectComp);
  if (suspect.length) {
    ledger("machine-blocked-suspect", { cards: suspect.map((v) => ({ nft: v.nft, item: v.itemName, paid: v.paidUsd, comp: v.compUsd })) });
    log.warn("capsule", `refusing to build: ${suspect.length} card(s) with suspect comps — re-price them in /admin first`);
    return null;
  }
  const priceUsd = cfg.capsuleUsd;
  const rolledIn = state.rolloverUsd;
  // chase = the best card in the basket; it headlines the machine
  const cards = [...basket].sort((a, b) => b.compUsd - a.compUsd);
  const chase = cards[0];
  const cardsValue = cards.reduce((s, c) => s + c.compUsd, 0);
  // size the machine so no single card exceeds maxCardShare of the pool —
  // that share is what drives per-machine variance (see header)
  const capsules = Math.max(
    cards.length + 2,
    Math.ceil(chase.compUsd / (priceUsd * cfg.maxCardShare)),
    Math.ceil((cardsValue + rolledIn) / priceUsd),
  );
  const prizes = buildPrizes(cards, capsules, priceUsd, rolledIn);
  if (!prizes) return null;
  const id = crypto.randomBytes(6).toString("hex");
  const m: Machine = {
    id, title: chase.itemName, nft: chase.nft, capsules, priceUsd, prizes,
    opens: [], commitHash: "", status: "open",
    rolledInUsd: rolledIn, createdAt: Date.now(),
  };
  m.commitHash = crypto.createHash("sha256").update(machineManifest(m)).digest("hex");
  m.commitSig = await publishCommit(id, m.commitHash, 0); // slot 0 = "no future slot; per-open entropy"
  state.rolloverUsd = 0;
  for (const v of cards) {
    v.machineId = id;
    v.status = "machined";
  }
  state.machines.push(m);
  save();
  ledger("machine-open", {
    id, nft: chase.nft, item: chase.itemName, capsules, startPriceUsd: priceUsd,
    cards: cards.length, chaseUsd: chase.compUsd,
    chaseShare: +(chase.compUsd / (capsules * priceUsd)).toFixed(3),
    cardsValue: +cardsValue.toFixed(2),
    cashValue: +(capsules * priceUsd + rolledIn - cardsValue).toFixed(2),
    rolledInUsd: rolledIn, commit: m.commitHash,
  });
  log.info("capsule", `MACHINE ${id}: ${capsules} capsules from $${priceUsd} — ${cards.length} cards (chase ${chase.itemName.slice(0, 34)} $${chase.compUsd}, ${(100 * chase.compUsd / (capsules * priceUsd)).toFixed(0)}% of rack) + cash${rolledIn ? ` (+$${rolledIn} rolled in)` : ""}`);
  return m;
}

/**
 * Open capsules. txSig/slot/blockhash come from the payment tx in live
 * mode; budgetUsd (what the buyer actually paid) then decides how many
 * capsules that buys at the live price, which may have moved between the
 * quote and the confirmation. Whatever is left over is refunded.
 */
export async function openCapsules(
  machineId: string, buyer: string, n: number,
  entropy?: { txSig: string; slot: number; blockhash: string },
  budgetUsd?: number,
): Promise<{ ok: boolean; prizes?: Prize[]; spentUsd?: number; why?: string }> {
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
  // ONE price for the whole batch, fixed before the first capsule opens.
  // Drawing k capsules from the rack has expected value k × the rack mean,
  // so charging the opening mean for every capsule in the batch is exactly
  // fair — and it means "pay for 3, get 3". (Re-pricing per capsule inside
  // a batch is also fair but drifts: on devnet a buyer paid for 3, the
  // rack ticked up a cent mid-batch, and the third capsule was refused.)
  const price = capsulePrice(m);
  let budget = budgetUsd ?? Infinity;
  let spent = 0;
  for (let k = 0; k < n; k++) {
    left = remainingIdx();
    if (!left.length) break;
    if (price > budget + 0.005) break; // paid amount exhausted
    budget -= price;
    spent += price;
    // multi-capsule opens chain the draw: k is appended so each capsule
    // in one tx gets an independent draw, still fully recomputable
    const pick = left[openIndex(m.id, `${e.txSig}:${k}`, e.blockhash, left.length)];
    const prize = m.prizes[pick];
    prize.claimedBy = buyer;
    m.opens.push({ buyer, txSig: `${e.txSig}:${k}`, slot: e.slot, blockhash: e.blockhash, prizeIdx: pick, priceUsd: price, at: Date.now() });
    won.push(prize);
    if (!cfg.live) state.walletUsd += price;
    if (prize.kind === "cash") {
      if (cfg.live) queuePayout({ kind: "usdc", to: buyer, amountUsd: prize.valueUsd, raffleId: m.id, reason: `capsule prize ${prize.label}` });
      else state.walletUsd -= prize.valueUsd;
    } else {
      // any card prize ships to the winner; the vault entry follows it
      const v = state.vault.find((x) => x.nft === prize.nft);
      if (v) v.status = "awarded";
      if (cfg.live)
        queuePayout({ kind: "nft", to: buyer, nft: prize.nft!, raffleId: m.id, reason: prize.nft === m.nft ? "capsule headline card" : "capsule card prize" });
    }
    ledger("capsule-open", { machine: m.id, buyer, paidUsd: price, prize: prize.label, valueUsd: prize.valueUsd, txSig: `${e.txSig}:${k}`, slot: e.slot, blockhash: e.blockhash, prizeIdx: pick });
  }
  if (!won.length) return { ok: false, why: "payment below the current capsule price" };
  // NOTHING ends the machine early — it runs until the rack is empty. (A
  // jackpot that closes the machine is the negative-EV trap; see header.)
  if (!remainingIdx().length) closeMachine(m, "sold out");
  save();
  if (won.some((p) => p.kind === "card" && p.nft === m.nft))
    log.info("capsule", `💥 CHASE CARD popped in ${m.id} → ${buyer} — price drops to $${capsulePrice(m).toFixed(2)}`);
  return { ok: true, prizes: won, spentUsd: +spent.toFixed(2) };
}

function closeMachine(m: Machine, why: string): void {
  m.status = "closed";
  m.closedAt = Date.now();
  const cards = state.vault.filter((v) => v.machineId === m.id);
  // unclaimed cards go back to the vault for the next machine; unclaimed
  // CASH rolls over — the house keeps neither
  let returned = 0;
  for (const v of cards) {
    if (v.status === "awarded") continue;
    v.status = "vault";
    v.machineId = undefined;
    returned++;
  }
  const rollover = +m.prizes.filter((p) => !p.claimedBy && p.kind === "cash").reduce((s, p) => s + p.valueUsd, 0).toFixed(2);
  m.rolledOutUsd = rollover;
  state.rolloverUsd = +(state.rolloverUsd + rollover).toFixed(2);
  const proceeds = +m.opens.reduce((s, o) => s + (o.priceUsd ?? m.priceUsd), 0).toFixed(2);
  const cashPaid = m.prizes.filter((p) => p.claimedBy && p.kind === "cash").reduce((s, p) => s + p.valueUsd, 0);
  // only cards that actually shipped are a cost to this machine
  const cardsCost = cards.filter((v) => v.status === "awarded").reduce((s, v) => s + v.paidUsd, 0);
  const profit = +(proceeds - cashPaid - rollover - cardsCost).toFixed(2);
  state.realizedProfitUsd = +(state.realizedProfitUsd + profit).toFixed(2);
  const toPool = +(Math.max(0, profit) * cfg.holderRaffleShare).toFixed(2);
  state.holderPoolUsd = +(state.holderPoolUsd + toPool).toFixed(2);
  if (!cfg.live) state.walletUsd -= toPool;
  ledger("machine-close", { machine: m.id, why, opens: m.opens.length, of: m.capsules, proceeds, cashPaid: +cashPaid.toFixed(2), rolledOutUsd: rollover, cardsCost: +cardsCost.toFixed(2), cardsReturned: returned, profit, toHolderPool: toPool });
  log.info("capsule", `CLOSED ${m.id} (${why}) — ${m.opens.length}/${m.capsules} opened, profit $${profit}, $${rollover} rolls over${returned ? `, ${returned} card(s) back to vault` : ""}`);
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
