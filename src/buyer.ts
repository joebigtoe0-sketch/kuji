import { cfg } from "./config.js";
import type { Listing } from "./cc.js";
import { signAndSendBase64, ownsNft, usdcBalance } from "./wallet.js";
import { walletPk } from "./wallet.js";
import { ledger } from "./store.js";
import { log } from "./log.js";
import { halted } from "./halt.js";

/**
 * Real buy rails (LIVE_MODE). Verified against the API 2026-08-26:
 * POST /marketplace/buy {wallet, nftAddress} returns the serialized
 * transaction as raw base64 TEXT (not JSON) — a VersionedTransaction
 * already signed by Collector Crypt's fee-payer wallet, with an empty
 * signature slot for the buyer. We sign our slot and broadcast. The tx
 * carries a recent blockhash, so it must be sent within ~60s of fetching.
 * Errors come back as JSON ({statusCode, message}) — parse before signing.
 */

const BASE = cfg.devnet ? "https://dev-api.collectorcrypt.com" : "https://api.collectorcrypt.com";
const H = { "content-type": "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

export interface BuyResult { ok: boolean; sig?: string; why?: string }

export async function realBuy(l: Listing): Promise<BuyResult> {
  if (!cfg.live) return { ok: false, why: "not in live mode" };
  if (halted()) return { ok: false, why: "machine is halted" };
  if (l.priceUsd > cfg.liveMaxCardUsd)
    return { ok: false, why: `$${l.priceUsd} exceeds live per-card cap $${cfg.liveMaxCardUsd}` };
  const bal = await usdcBalance();
  if (bal < l.priceUsd + 1) // +1 buffer for marketplace rounding
    return { ok: false, why: `USDC balance $${bal.toFixed(2)} < price $${l.priceUsd}` };

  // fetch the buy tx and send it immediately — the blockhash is ticking
  const res = await fetch(`${BASE}/marketplace/buy`, {
    method: "POST", headers: H,
    body: JSON.stringify({ wallet: walletPk.toBase58(), nftAddress: l.nft }),
  });
  const body = (await res.text()).trim();
  if (!res.ok || body.startsWith("{")) {
    let why = body.slice(0, 200);
    try { why = JSON.parse(body).message ?? why; } catch {}
    // "Card not found" / "already sold" = someone beat us to it. Normal.
    ledger("live-buy-rejected", { nft: l.nft, item: l.itemName, price: l.priceUsd, why });
    return { ok: false, why };
  }

  let sig: string;
  try {
    sig = await signAndSendBase64(body, `buy ${l.itemName.slice(0, 40)}`);
  } catch (e) {
    // failed on-chain (blockhash expired, sold mid-flight, balance race).
    // Nothing to unwind: the tx either landed fully or not at all.
    const why = String(e).slice(0, 200);
    ledger("live-buy-failed", { nft: l.nft, item: l.itemName, price: l.priceUsd, why });
    log.warn("buyer", `buy failed: ${why}`);
    return { ok: false, why };
  }

  // ownership check — the tx confirmed, but trust nothing: poll until the
  // NFT actually sits in our wallet (or give up loudly and flag for review)
  for (let i = 0; i < 10; i++) {
    if (await ownsNft(l.nft)) {
      ledger("live-buy", { nft: l.nft, item: l.itemName, price: l.priceUsd, sig });
      log.info("buyer", `LIVE BUY confirmed + owned: ${l.itemName.slice(0, 50)} @ $${l.priceUsd} (${sig})`);
      return { ok: true, sig };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  ledger("live-buy-UNVERIFIED", { nft: l.nft, item: l.itemName, price: l.priceUsd, sig, why: "tx confirmed but ownership not visible after 30s — REVIEW" });
  log.warn("buyer", `buy ${sig} confirmed but ownership unverified — flagged for review`);
  return { ok: true, sig, why: "ownership unverified — review flagged" };
}
