# NERDNAME — the card machine

A zero-edge gacha for graded trading cards, built by RIKU for AnsemHack.

The machine snipes underpriced vaulted-card NFTs on Collector Crypt, then
raffles each card at **exactly** its market value (N tickets × comp/N).
The house takes nothing at the raffle — its only profit is the discount it
caught at the snipe. Half of realized profit funds **free raffles for token
holders** (holding is the ticket, weighted by balance; $ANSEM holders get a
weight boost). Every draw is committed to a **future Solana blockhash**
before the first ticket exists, and independently verifiable.

## Modes

| | paper (default) | live |
|---|---|---|
| market data | real | real |
| draws | real mainnet blockhashes | real + memo-anchored commit/reveal |
| money | simulated | USDC on Solana |
| buys | bookkeeping | signed CC buy txs + ownership check |
| tickets | simulator | Phantom widget → memo'd transfer → chain watcher |
| refunds/prizes | ledger lines | payout queue (USDC / NFT transfers) |

`LIVE_MODE=true` flips everything at once; `DEVNET=true` runs live mode
against Collector Crypt's devnet and Solana devnet. See `.env.example`.

## Run

```
npm install
cp .env.example .env
npm run dev        # http://127.0.0.1:8630
```

## How the fairness works

1. At raffle open: `commitHash = sha256(manifest | secretSeed | resolveSlot)`
   is published (live: as a Solana memo tx) — the resolve slot is a **future**
   slot, so its blockhash cannot be known by anyone, including us.
2. Sold out → at the resolve slot: `rand = sha256(seed | blockhash(resolveSlot))`,
   winner = rejection-sampled unbiased index into the flattened ticket list.
3. Seed revealed (live: reveal memo). `/api/verify/:id` recomputes the whole
   chain from public data; anyone can do the same by hand.
4. Not sold out by the deadline → status `refunded`, every buyer repaid.

## Safety rails

- Sniper: min/max edge band, max 3 buys/sweep, per-card concentration cap,
  one copy per card identity, `LIVE_MAX_CARD_USD` hard cap on real buys.
- Comps: only fresh (<48h) same-card listings, candidate must be the floor,
  comp = min(2nd-lowest, median) × haircut, unpriceable if the spread is
  absurd. Cards whose edge still looks too good **never raffle** until a
  human re-prices them (`/api/admin/reprice`).
- Kill switch: `data/HALT` file or `POST /api/admin/halt` stops everything
  that spends or moves; the site stays up read-only.
- Payments: tickets credit from what actually arrived on-chain, never from
  what the memo claims; overpayment and sellout races refund automatically.
- Payouts: durable queue, retries with backoff, loud "stuck" state — never
  silently dropped.

## Layout

`src/` — `cc.ts` marketplace client · `comps.ts` pricing · `sniper.ts` scan+buy
· `buyer.ts` real buy rails · `raffles.ts` lifecycle · `draw.ts` commit-reveal
· `commitchain.ts` memo anchoring · `payments.ts` ticket payments ·
`payouts.ts` refunds+prizes · `holders.ts` snapshots · `grader.ts` edge
validation · `site.ts` storefront · `sim.ts` paper crowd · `halt.ts` kill switch

State: `data/state.json` + append-only `data/ledger.jsonl` (every decision,
with reasoning). Secrets (`data/wallet.json`, seeds) never leave `data/`,
which is gitignored.
