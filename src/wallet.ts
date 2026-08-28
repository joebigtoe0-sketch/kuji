import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction,
  ComputeBudgetProgram, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { cfg } from "./config.js";
import { log } from "./log.js";

/**
 * The machine's wallet. One keypair does everything: buys cards, receives
 * ticket payments, pays refunds, sends prizes, publishes commitments.
 * Secret comes from WALLET_SECRET (base58 or JSON byte array); with none
 * set, a keypair is generated to data/wallet.json so devnet testing works
 * out of the box. NEVER commit data/.
 */

export const connection = new Connection(cfg.rpcUrl, "confirmed");

function loadKeypair(): Keypair {
  const s = cfg.walletSecret.trim();
  if (s.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  if (s) return Keypair.fromSecretKey(bs58.decode(s));
  const f = path.join(cfg.dataDir, "wallet.json");
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
  } catch {
    const kp = Keypair.generate();
    fs.writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)));
    log.warn("wallet", `generated NEW keypair ${kp.publicKey.toBase58()} → data/wallet.json (fund it before live mode)`);
    // On a host with ephemeral disk this fires on EVERY deploy: a brand new
    // wallet each time, with the funded one stranded and unrecoverable.
    // Loud, because silence here costs real money.
    if (process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV === "production") {
      log.warn("wallet", "⚠ RUNNING DEPLOYED WITH NO WALLET ON DISK.");
      log.warn("wallet", "⚠ Either set WALLET_SECRET, or mount a persistent volume at the data dir —");
      log.warn("wallet", "⚠ otherwise every redeploy mints a new wallet and abandons the funded one.");
    }
    return kp;
  }
}

export const wallet: Keypair = loadKeypair();
export const walletPk: PublicKey = wallet.publicKey;

export async function solBalance(): Promise<number> {
  return (await connection.getBalance(walletPk)) / 1e9;
}

/** UI-unit balance of any SPL token in our ATA (0 if the ATA doesn't exist). */
export async function tokenBalance(mint: string, owner: PublicKey = walletPk): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, true);
    const acc = await getAccount(connection, ata);
    const info = await connection.getParsedAccountInfo(ata);
    const dec = (info.value?.data as any)?.parsed?.info?.tokenAmount?.decimals ?? 6;
    return Number(acc.amount) / 10 ** dec;
  } catch {
    return 0;
  }
}

export const usdcBalance = () => tokenBalance(cfg.usdcMint);

/** Sign+send a legacy tx built by us, with confirmation. */
export async function sendTx(ixs: TransactionInstruction[], label: string): Promise<string> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...ixs,
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: "confirmed", maxRetries: 5,
  });
  log.info("wallet", `${label}: ${sig}`);
  return sig;
}

/**
 * Sign+send a transaction someone else built (Collector Crypt's buy tx).
 * Accepts base64; handles both versioned and legacy wire formats.
 */
export async function signAndSendBase64(b64: string, label: string): Promise<string> {
  const raw = Buffer.from(b64, "base64");
  let sig: string;
  try {
    const vtx = VersionedTransaction.deserialize(raw);
    vtx.sign([wallet]);
    sig = await connection.sendTransaction(vtx, { maxRetries: 5 });
  } catch {
    const tx = Transaction.from(raw);
    tx.partialSign(wallet);
    sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  }
  const bh = await connection.getLatestBlockhash("confirmed");
  const conf = await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (conf.value.err) throw new Error(`${label} tx failed on-chain: ${JSON.stringify(conf.value.err)}`);
  log.info("wallet", `${label}: ${sig}`);
  return sig;
}

/** Do we own exactly this NFT? (post-buy ownership check) */
export async function ownsNft(mint: string): Promise<boolean> {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), walletPk, true);
    const acc = await getAccount(connection, ata);
    return acc.amount === 1n;
  } catch {
    return false;
  }
}
