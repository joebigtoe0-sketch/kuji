# KUJI — the zero-edge capsule machine

A machine that buys underpriced graded trading cards on [Collector Crypt](https://collectorcrypt.com),
then hands them back out through capsule machines and raffles **at exactly what they are worth**.

Its only profit is the discount it caught at the counter. There is no house edge — prices and odds
are public, committed on-chain before anyone can buy, and anyone can recompute any draw.

## How it works

**It snipes.** Every 10 minutes it prices every listing against a comp index built from live
listings of the same card in the same grade, and buys only when the discount is real. Guardrails:
max buys per sweep, per-card share of the bankroll, and a rule that an edge which looks *too* good
(a thin comp group with two moonshot asks) is flagged for a human instead of bought.

**It fills capsule machines.** A basket of cards becomes a rack of capsules padded with cash
envelopes, where `sum(prizes) == capsules × price` exactly. **The price floats**: a capsule always
costs `value still in the rack ÷ capsules still in the rack`. That is the load-bearing idea — with
a fixed price and a public rack, buyers would wait for the good states and skip the bad ones, and
at zero house edge the machine pays for that option. Floating the price makes every capsule a fair
bet at the instant it is bought, so the rack sells through instead of stalling.

**It runs raffles.** Bigger cards split into N tickets at exactly `comp ÷ N`, fill-or-refund: if it
does not sell out by the deadline everyone is repaid and the card returns to the vault. Tickets
trade until the draw, so the last trade is a live market price on the card.

**It gives half the profit back.** Half of realized profit funds free raffles for token holders,
weighted by balance. Holding is the ticket.

### Fairness

Raffle draws are commit-reveal against a **future** Solana blockhash named in a commitment
published before any ticket exists — nobody can grind seeds against a blockhash that does not exist
yet. Capsule opens use `sha256(machineId | your tx signature | blockhash of your confirmation
slot)`: your signature is fixed before that blockhash exists, and the machine controls neither.
`/api/verify/:id` and `/api/verify-machine/:id` recompute any result from published data alone.

## Modes

| | paper (default) | live |
|---|---|---|
| market data | real | real |
| draws | real mainnet blockhashes | real, plus memo-anchored commit/reveal |
| money | simulated | USDC and SOL on Solana |
| buys | bookkeeping | signed Collector Crypt buy txs + ownership check |
| purchases | simulator | Phantom → memo'd transfer → chain watcher |
| refunds and prizes | ledger lines | durable payout queue |

Paper mode is a real simulation, not a mock: real marketplace data, real mainnet blockhashes, real
cryptography, fake money.

## Running locally

```bash
npm install
npm run dev          # paper mode on http://127.0.0.1:8630
npm run typecheck    # before committing
```

## Deploying to Railway

1. **Create the service** from this repo. Nixpacks runs `npm start`; `railway.json` sets the
   healthcheck (`/health`) and restart policy.

2. **Mount a volume at `/app/data`.** Not optional. `data/` holds the wallet key, machine state,
   the raffle seeds and the ledger. Without a volume every redeploy starts from an empty disk,
   generates a **new wallet**, and strands the funded one. The app logs a loud warning when it
   detects this, but the volume is the actual fix.

3. **Set the environment** (see `.env.example`). For a live deployment, at minimum:

   | variable | why |
   |---|---|
   | `ADMIN_KEY` | guards `/admin`. Live mode **refuses to start** without it — no key, no kill switch. |
   | `RPC_URL` | a real RPC. Public endpoints rate-limit `getBlock` (every capsule open needs one) and refuse `getProgramAccounts` (holder snapshots). |
   | `DAS_URL` | DAS-capable RPC (Helius). Required in live mode: some cards are compressed NFTs, which have no on-chain account to read. |
   | `LIVE_MODE` | leave unset. Flip live from `/admin` once the wallet is funded — it applies immediately, no redeploy. |

4. **Make the wallet up front**, so the key exists somewhere you control rather than only on a
   server disk:

   ```bash
   npm run newwallet
   ```

   It prints the **public address** and writes the private key to `data/WALLET-SECRET.txt` —
   never to the terminal, because anything echoed there lives on in scrollback, shell history
   and screen shares. Copy that one line into Railway as `WALLET_SECRET`, import the same key
   into Phantom if you want to watch the wallet or move funds by hand, back it up in a password
   manager, then delete the file. After deploying, check that `/admin` shows the same address
   and reports its key source as `WALLET_SECRET` — that is your proof the right key loaded.

   (You can skip this and let the app generate one on the volume instead, but then the key
   exists in exactly one place: that disk. Lose or recreate the volume and the funds are gone
   permanently.)

   Use a **fresh** wallet either way — this is a hot key living on a server, not somewhere to
   point an existing wallet. `/admin` shows which source the running key came from.

5. **Fund it.** The address is in `/admin`. It needs USDC to snipe with and a little SOL for
   fees. With an empty wallet, live mode simply idles.

6. **Go live from `/admin`**, where you also set the token contract address and X link, and where
   the halt switch lives.

Note that a volume is required **regardless** of how you supply the key: `data/` also holds
`seeds.txt`, and losing those makes any open raffle impossible to resolve — the seed is what proves
the published commitment.

## Safety rails

- **Sniper**: min/max edge band, max buys per sweep, per-card concentration cap, one copy per card
  identity, and a hard per-card cap on real buys.
- **Comps**: only fresh same-card listings, the candidate must be the floor, comp is
  `min(2nd-lowest, median) × haircut`. A card whose edge still looks too good **never** reaches a
  raffle or a capsule rack until a human re-prices it — the rack price *is* the capsule price, so
  one bogus comp would overcharge every buyer.
- **Kill switch**: `data/HALT` or `POST /api/admin/halt` stops everything that spends or moves;
  the site stays up read-only.
- **Payments**: credited from what actually arrived on-chain, never from what a memo claims.
  Overpayments, sellout races and closed machines refund automatically.
- **Payouts**: durable queue, retries with backoff, loud `stuck` state — never silently dropped.
- **Asset standards**: cards come as classic SPL, MPL Core, or compressed NFTs; ownership checks
  and prize transfers dispatch on each. All three paths were exercised against devnet.

## Layout

| file | what it does |
|---|---|
| `sniper.ts` | scans, prices, buys — with the guardrails |
| `cc.ts` / `solprice.ts` | marketplace client; USD normalisation for SOL-priced listings |
| `comps.ts` | the comp index — what a card is worth |
| `capsules.ts` | capsule machines, floating price, prize tables |
| `raffles.ts` | paid raffles, fill-or-refund, holder raffles |
| `market.ts` | tradable-ticket secondary market |
| `draw.ts` | commit-reveal and the unbiased sampler |
| `assets.ts` | ownership and transfers across the three NFT standards |
| `payments.ts` / `payouts.ts` | incoming payments; outgoing refunds and prizes |
| `grader.ts` | did the edges turn out real? the go/no-go number |
| `site.ts` | the storefront |

State lives in `data/state.json` plus an append-only `data/ledger.jsonl` recording every decision
with its reasoning. Secrets (`data/wallet.json`, `data/seeds.txt`) never leave `data/`, which is
gitignored and has never been committed.
