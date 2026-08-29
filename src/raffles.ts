import crypto from "node:crypto";
import { cfg } from "./config.js";
import { state, save, ledger, type Raffle, type VaultCard } from "./store.js";
import { makeSeed, commitHash, currentSlot, blockhashAtOrAfter, winningIndex } from "./draw.js";
import { log } from "./log.js";
import { publishCommit, publishReveal } from "./commitchain.js";
import { queuePayout } from "./payouts.js";
import { halted } from "./halt.js";

/**
 * Raffles, both kinds:
 *
 * PAID  — a sniped card split into N tickets priced at exactly compValue/N
 *         (zero house edge — the machine's profit was already earned at the
 *         snipe). FILL-OR-REFUND: resolves only if every ticket sells before
 *         the deadline; otherwise refunds, card returns to the vault.
 *
 * HOLDER — free. Funded by HOLDER_RAFFLE_SHARE of realized profit: when the
 *         pool can afford a vault card (at comp value), that card is raffled
 *         to token holders, entries weighted by balance. Holding IS the
 *         ticket. (Paper mode simulates a holder set.)
 *
 * Both use the same commitment: sha256(manifest | seed | resolveSlot) with a
 *  FUTURE slot named before any ticket exists.
 */

const SLOTS_PER_HOUR = 9000; // ~2.5 slots/s
import fs from "node:fs";

function seeds(): Map<string, string> {
  // secret seeds live outside state.json so the "reveal" actually means something
  const m = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(`${cfg.dataDir}/seeds.txt`, "utf8").split("\n")) {
      const [id, seed] = line.split(":");
      if (id && seed) m.set(id, seed.trim());
    }
  } catch {}
  return m;
}
function saveSeed(id: string, seed: string): void {
  fs.appendFileSync(`${cfg.dataDir}/seeds.txt`, `${id}:${seed}\n`);
}

const NERD_OPEN = [
  "manifest is public. odds are math. cope elsewhere.",
  "i did the pricing so you don't have to trust me. verify it.",
  "every ticket costs exactly what it's worth. revolutionary, apparently.",
  "the commit hash is already on file. i can't cheat and neither can you.",
];

/** Keep MAX_OPEN_RAFFLES paid raffles running from the vault, oldest first. */
export async function autoRaffle(): Promise<void> {
  if (halted()) return;
  const open = state.raffles.filter((r) => r.kind === "paid" && r.status === "open").length;
  if (open >= cfg.maxOpenRaffles) return;
  const pool = state.vault
    .filter((v) => v.status === "vault" && !suspectComp(v))
    .sort((a, b) => a.boughtAt - b.boughtAt);
  // reserve the cheapest machine-eligible card for the capsule machine
  const machineWaiting = !state.machines.some((m) => m.status === "open");
  const reserved = machineWaiting
    ? pool.filter((v) => v.compUsd <= cfg.machineMaxCardUsd).sort((a, b) => a.compUsd - b.compUsd)[0]
    : undefined;
  const card = pool.find((v) => v !== reserved);
  if (!card) return;
  await createPaidRaffle(card);
}

/**
 * THE RULE: a card whose edge looks too good to be true never raffles at
 * that comp — a bogus comp would mean overpriced tickets sold to real
 * people. Suspect cards sit in the vault until a human re-prices them.
 */
/**
 * Who holds ticket index `idx`?
 *
 * Walks cumulative counts instead of materialising the ticket list. A
 * balance-weighted holder raffle can have HUNDREDS OF MILLIONS of entries
 * (one per whole token held), and flattening that into an array of buyer
 * strings exhausts memory and takes the process down at resolve time —
 * which is exactly when a live raffle must not fail.
 */
export function ownerAtIndex(sold: { buyer: string; n: number }[], idx: number): string | undefined {
  let acc = 0;
  for (const t of sold) {
    acc += t.n;
    if (idx < acc) return t.buyer;
  }
  return undefined;
}

export const totalEntries = (sold: { n: number }[]): number => sold.reduce((s, t) => s + t.n, 0);

export function suspectComp(v: VaultCard): boolean {
  if (v.compUsd <= 0 || v.paidUsd <= 0) return true;
  const edge = (v.compUsd - v.paidUsd) / v.compUsd;
  return edge > cfg.maxEdge;
}

export async function createPaidRaffle(card: VaultCard): Promise<Raffle> {
  const tickets = Math.max(cfg.ticketsMin, Math.min(cfg.ticketsMax, Math.round(card.compUsd / 10)));
  const ticketUsd = +(card.compUsd / tickets).toFixed(2);
  const slotNow = await currentSlot();
  const resolveSlot = slotNow + Math.round((cfg.raffleFillHours + cfg.resolveDelayMin / 60) * SLOTS_PER_HOUR);
  const id = crypto.randomBytes(6).toString("hex");
  const seed = makeSeed();
  const manifest = JSON.stringify({ id, nft: card.nft, item: card.itemName, tickets, ticketUsd, rule: "resolves only if sold out by deadline; else refund" });
  const r: Raffle = {
    id, kind: "paid", nft: card.nft, title: card.itemName,
    tickets, ticketUsd, sold: [],
    createdAt: Date.now(),
    fillDeadline: Date.now() + cfg.raffleFillHours * 3600_000,
    resolveSlot,
    commitHash: commitHash(manifest, seed, resolveSlot),
    status: "open",
  };
  saveSeed(id, seed);
  // the commit must exist on-chain BEFORE any ticket can sell — in live
  // mode a failed publish aborts the open (card stays in the vault)
  r.commitSig = await publishCommit(id, r.commitHash, resolveSlot);
  card.raffleId = id;
  card.status = "raffled";
  state.raffles.push(r);
  save();
  ledger("raffle-open", { id, kind: "paid", nft: card.nft, item: card.itemName, tickets, ticketUsd, commit: r.commitHash, commitSig: r.commitSig, resolveSlot, note: NERD_OPEN[Math.floor(Math.random() * NERD_OPEN.length)] });
  log.info("raffle", `OPEN ${id}: ${card.itemName.slice(0, 50)} — ${tickets} x $${ticketUsd} (comp $${card.compUsd})`);
  return r;
}

/** Paper ticket purchase. */
export function buyTickets(raffleId: string, buyer: string, n: number): { ok: boolean; why?: string } {
  const r = state.raffles.find((x) => x.id === raffleId);
  if (!r || r.status !== "open" || r.kind !== "paid") return { ok: false, why: "no open paid raffle" };
  const soldN = r.sold.reduce((s, t) => s + t.n, 0);
  if (soldN + n > r.tickets) return { ok: false, why: "not enough tickets left" };
  r.sold.push({ buyer, n, paidUsd: +(n * r.ticketUsd).toFixed(2), at: Date.now() });
  save();
  ledger("ticket-buy", { raffle: r.id, buyer, n, paidUsd: +(n * r.ticketUsd).toFixed(2) });
  return { ok: true };
}

/** Fill-or-refund + resolution — run on a timer. */
export async function tickRaffles(): Promise<void> {
  // The kill switch has to stop DRAWS too, not just money. A raffle whose
  // entry list turns out to be wrong (a bonding curve counted as a holder,
  // say) must be stoppable before it resolves — halting only the payout
  // leaves a published winner that should never have been drawn.
  if (halted()) return;
  for (const r of state.raffles.filter((x) => x.status === "open")) {
    const soldN = r.sold.reduce((s, t) => s + t.n, 0);
    const card = state.vault.find((v) => v.nft === r.nft);

    if (r.kind === "paid" && soldN < r.tickets && Date.now() > r.fillDeadline) {
      r.status = "refunded";
      if (card) { card.status = "vault"; card.raffleId = undefined; }
      // live: every buyer gets their money back, aggregated per wallet
      const owed = new Map<string, number>();
      for (const t of r.sold) owed.set(t.buyer, (owed.get(t.buyer) ?? 0) + t.paidUsd);
      for (const [buyer, usd] of owed)
        queuePayout({ kind: "usdc", to: buyer, amountUsd: +usd.toFixed(2), raffleId: r.id, reason: "fill-or-refund: raffle did not sell out" });
      save();
      ledger("raffle-refund", { raffle: r.id, sold: soldN, of: r.tickets, refunds: owed.size });
      log.info("raffle", `REFUND ${r.id} — ${soldN}/${r.tickets} sold, ${owed.size} refunds queued`);
      continue;
    }
    if (soldN < r.tickets) continue; // still filling

    // sold out (or holder raffle fully entered) — wait for the slot, then draw
    const slotNow = await currentSlot().catch(() => 0);
    if (!slotNow || slotNow < r.resolveSlot) continue;
    const seed = seeds().get(r.id);
    if (!seed) { log.warn("raffle", `${r.id}: seed missing!`); continue; }
    try {
      const { blockhash } = await blockhashAtOrAfter(r.resolveSlot);
      const total = totalEntries(r.sold);
      const idx = winningIndex(seed, blockhash, total);
      r.winner = ownerAtIndex(r.sold, idx);
      r.winnerIndex = idx;
      r.seed = seed;
      r.blockhash = blockhash;
      r.status = "resolved";
      r.resolvedAt = Date.now();

      // a ticket giveaway moves the parked seats to the winner instead
      if (r.prizeKind === "tickets") {
        const target = state.raffles.find((x) => x.id === r.prizeRaffleId);
        const parked = target?.sold.find((t) => t.buyer === GIVEAWAY_HOLDER(r.id));
        if (target && parked && r.winner) {
          if (target.status === "open") {
            parked.buyer = r.winner;
            log.info("raffle", `${r.prizeTickets} ticket(s) in ${target.id} handed to ${r.winner}`);
          } else {
            // target resolved or refunded while we were drawing — pay the
            // face value instead so the winner is not left with nothing
            if (cfg.live) queuePayout({ kind: "usdc", to: r.winner, amountUsd: parked.paidUsd, raffleId: r.id, reason: `ticket giveaway: ${target.id} closed before the draw, paid face value instead` });
            ledger("giveaway-cashout", { raffle: r.id, target: target.id, winner: r.winner, usd: parked.paidUsd });
          }
        }
      } else if (card) card.status = r.kind === "paid" ? "awarded" : "holder_prize";
      if (r.kind === "paid" && card) {
        // proceeds return; the SPREAD is realized profit; half funds holder raffles
        const proceeds = r.tickets * r.ticketUsd;
        const profit = +(proceeds - card.paidUsd).toFixed(2);
        if (!cfg.live) state.walletUsd += proceeds; // live: the money already arrived on-chain
        state.realizedProfitUsd += profit;
        const toPool = +(Math.max(0, profit) * cfg.holderRaffleShare).toFixed(2);
        state.holderPoolUsd += toPool; // live: an earmark inside the same wallet
        if (!cfg.live) state.walletUsd -= toPool;
        ledger("profit", { raffle: r.id, proceeds, cost: card.paidUsd, profit, toHolderPool: toPool });
      }
      // the prize: the NFT goes to the winner's wallet (live buyers ARE wallets).
      // Physical redemption is theirs via Collector Crypt's vault afterwards.
      if (cfg.live && r.winner && r.prizeKind !== "tickets")
        queuePayout({ kind: "nft", to: r.winner, nft: r.nft, raffleId: r.id, reason: `raffle prize (ticket ${idx + 1}/${total})` });
      r.revealSig = await publishReveal(r.id, seed, blockhash, idx);
      save();
      ledger("raffle-resolve", { raffle: r.id, winner: r.winner, winnerIndex: idx, of: total, blockhash, seedRevealed: seed, revealSig: r.revealSig });
      log.info("raffle", `RESOLVED ${r.id} — winner ${r.winner} (ticket ${idx + 1}/${total})`);
    } catch (e) {
      log.warn("raffle", `${r.id} resolve: ${String(e).slice(0, 100)}`);
    }
  }
}

/** Holder raffle: when the pool affords a vault card, raffle it to holders. */
export async function tickHolderRaffles(holders: { wallet: string; balance: number }[]): Promise<void> {
  if (halted()) return;
  if (state.raffles.some((r) => r.kind === "holder" && r.status === "open")) return;
  const candidate = state.vault
    .filter((v) => v.status === "vault" && v.compUsd <= state.holderPoolUsd && !suspectComp(v))
    .sort((a, b) => b.compUsd - a.compUsd)[0];
  if (!candidate || !holders.length) return;
  await createHolderRaffle(candidate, holders, { fromPool: true });
}

/** Placeholder buyer that parks giveaway tickets until a winner is drawn. */
export const GIVEAWAY_HOLDER = (id: string) => `KUJI-GIVEAWAY-${id}`;

/**
 * Give away seats in a live paid raffle, free, to token holders.
 *
 * The tickets are BOUGHT at face value out of the holder pool the moment
 * the giveaway opens, and parked under a placeholder buyer until the draw.
 * That matters: a paid raffle only covers the card because every ticket is
 * paid for. Handing out free seats would leave the card underfunded and
 * quietly break the zero-edge promise for everyone who bought normally.
 * Reserving them up front also stops someone else buying the same seats
 * while the giveaway is running.
 */
export async function createTicketGiveaway(
  target: Raffle,
  nTickets: number,
  holders: { wallet: string; balance: number }[],
  opts: { fromPool: boolean },
): Promise<Raffle> {
  if (target.kind !== "paid" || target.status !== "open") throw new Error("target raffle is not open for tickets");
  if (!holders.length) throw new Error("no holders to raffle to");
  const left = target.tickets - target.sold.reduce((s, t) => s + t.n, 0);
  if (nTickets < 1 || nTickets > left) throw new Error(`only ${left} ticket(s) left in that raffle`);
  const cost = +(nTickets * target.ticketUsd).toFixed(2);
  if (opts.fromPool && state.holderPoolUsd < cost)
    throw new Error(`holder pool has $${state.holderPoolUsd.toFixed(2)}, needs $${cost.toFixed(2)}`);

  const slotNow = await currentSlot();
  const resolveSlot = slotNow + Math.round(0.5 * SLOTS_PER_HOUR);
  const id = crypto.randomBytes(6).toString("hex");
  const seed = makeSeed();
  const entries = holders.map((h) => ({ wallet: h.wallet, n: Math.max(1, Math.floor(h.balance)) }));
  const total = entries.reduce((s, e) => s + e.n, 0);
  const manifest = JSON.stringify({
    id, prize: { kind: "tickets", raffle: target.id, item: target.title, tickets: nTickets, faceUsd: cost },
    snapshot: entries, rule: "free holder raffle, entries = balance",
  });
  const r: Raffle = {
    id, kind: "holder", nft: target.nft,
    title: `HOLDER DROP — ${nTickets} ticket${nTickets === 1 ? "" : "s"} in ${target.title.slice(0, 44)}`,
    tickets: total, ticketUsd: 0,
    sold: entries.map((e) => ({ buyer: e.wallet, n: e.n, paidUsd: 0, at: Date.now() })),
    createdAt: Date.now(), fillDeadline: Date.now(), resolveSlot,
    commitHash: commitHash(manifest, seed, resolveSlot), status: "open",
    prizeKind: "tickets", prizeRaffleId: target.id, prizeTickets: nTickets,
  };
  saveSeed(id, seed);
  r.commitSig = await publishCommit(id, r.commitHash, resolveSlot);
  // pay for the seats now and park them
  if (opts.fromPool) state.holderPoolUsd = +(state.holderPoolUsd - cost).toFixed(2);
  target.sold.push({ buyer: GIVEAWAY_HOLDER(id), n: nTickets, paidUsd: cost, at: Date.now() });
  state.raffles.push(r);
  save();
  ledger("holder-raffle-open", { id, prize: "tickets", targetRaffle: target.id, tickets: nTickets, faceUsd: cost, entrants: entries.length, entries: total, poolSpent: opts.fromPool ? cost : 0, commit: r.commitHash, resolveSlot });
  log.info("raffle", `HOLDER DROP ${id}: ${nTickets} ticket(s) in ${target.id} ($${cost} ${opts.fromPool ? "from the pool" : "operator-funded"}) to ${entries.length} holders`);
  return r;
}

/**
 * Build a free, balance-weighted holder raffle for one card.
 *
 * `fromPool` is what separates the two ways a card gets given away:
 * the automatic drops are BOUGHT out of the holder pool (half of realized
 * profit), so the pool is debited. A card the operator supplies is a
 * donation, so nothing is debited — otherwise the pool would go negative
 * and the next automatic drop would be silently blocked.
 */
export async function createHolderRaffle(
  candidate: VaultCard,
  holders: { wallet: string; balance: number }[],
  opts: { fromPool: boolean },
): Promise<Raffle> {
  if (!holders.length) throw new Error("no holders to raffle to");
  const slotNow = await currentSlot();
  const resolveSlot = slotNow + Math.round(0.5 * SLOTS_PER_HOUR); // ~30 min
  const id = crypto.randomBytes(6).toString("hex");
  const seed = makeSeed();
  // entries weighted by balance — the snapshot IS the manifest
  const entries = holders.map((h) => ({ wallet: h.wallet, n: Math.max(1, Math.floor(h.balance)) }));
  const manifest = JSON.stringify({ id, nft: candidate.nft, item: candidate.itemName, snapshot: entries, rule: "free holder raffle, entries = balance" });
  const total = entries.reduce((s, e) => s + e.n, 0);
  const r: Raffle = {
    id, kind: "holder", nft: candidate.nft, title: `HOLDER DROP — ${candidate.itemName}`,
    tickets: total, ticketUsd: 0,
    sold: entries.map((e) => ({ buyer: e.wallet, n: e.n, paidUsd: 0, at: Date.now() })),
    createdAt: Date.now(), fillDeadline: Date.now(), resolveSlot,
    commitHash: commitHash(manifest, seed, resolveSlot), status: "open",
  };
  saveSeed(id, seed);
  r.commitSig = await publishCommit(id, r.commitHash, resolveSlot);
  if (opts.fromPool) state.holderPoolUsd = +(state.holderPoolUsd - candidate.compUsd).toFixed(2);
  candidate.raffleId = id;
  candidate.status = "raffled";
  state.raffles.push(r);
  save();
  ledger("holder-raffle-open", { id, nft: candidate.nft, item: candidate.itemName, entrants: entries.length, entries: total, poolSpent: opts.fromPool ? candidate.compUsd : 0, donated: !opts.fromPool, commit: r.commitHash, resolveSlot });
  log.info("raffle", `HOLDER DROP ${id}: ${candidate.itemName.slice(0, 50)} to ${entries.length} holders${opts.fromPool ? "" : " (operator-supplied)"}`);
  return r;
}
