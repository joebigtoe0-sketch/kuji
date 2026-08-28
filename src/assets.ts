import crypto from "node:crypto";
import { PublicKey, TransactionInstruction, SystemProgram, AccountMeta } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, getAccount, createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { cfg } from "./config.js";
import { connection, walletPk, sendTx } from "./wallet.js";

/**
 * Collector Crypt cards come in (at least) THREE asset standards — found
 * the hard way on the devnet dry run 2026-08-27:
 *   - classic SPL NFTs        (Tokenkeg mint + ATA)         — e.g. White Flare
 *   - MPL Core assets         (CoREENxT..., owner in-account) — most graded singles
 *   - compressed NFTs         (Bubblegum v1/v2, no account)  — devnet stock
 * Ownership checks and prize transfers dispatch on the standard. DAS
 * (Helius-style RPC) answers ownership for all three; transfers use the
 * standard's own instruction.
 */

const CORE_PROG = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const BGUM_PROG = new PublicKey("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
const NOOP_V1 = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const COMPRESSION_V1 = new PublicKey("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");
const NOOP_V2 = new PublicKey("mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3");
const COMPRESSION_V2 = new PublicKey("mcmt6YrQEMKw8Mw43FmpRLmf7BqRnFMKmAcbxE3xkAW");

export type AssetKind = "spl" | "core" | "cnft-v1" | "cnft-v2";
export interface AssetInfo { kind: AssetKind; owner: string }

function dasUrl(): string {
  if (cfg.dasUrl) return cfg.dasUrl;
  // Helius serves DAS and normal RPC on the SAME endpoint, so pointing
  // RPC_URL at Helius is all most setups need — DAS_URL is only for
  // splitting them across two providers.
  if (cfg.rpcUrl.includes("helius")) return cfg.rpcUrl;
  return "";
}

/** Can we read compressed NFTs at all? Without this, a compressed card
 *  cannot be ownership-checked after a buy, and cannot be shipped as a
 *  prize — the money moves and the card cannot follow. */
export const hasDas = (): boolean => !!dasUrl();

async function das(method: string, params: unknown): Promise<any> {
  const url = dasUrl();
  if (!url) throw new Error("no DAS RPC configured (set DAS_URL or use a Helius RPC_URL)");
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(`DAS ${method}: ${JSON.stringify(j.error).slice(0, 140)}`);
  return j.result;
}

/** What is this thing and who owns it? DAS when available; chain fallback
 *  for core/spl (compressed HAS no account, so cNFTs require DAS). */
export async function assetInfo(nft: string): Promise<AssetInfo> {
  if (dasUrl()) {
    const a = await das("getAsset", { id: nft });
    const iface = String(a.interface ?? "");
    const compressed = !!a.compression?.compressed;
    const kind: AssetKind = compressed
      ? (iface === "MplBubblegumV2" ? "cnft-v2" : "cnft-v1")
      : iface === "MplCoreAsset" ? "core" : "spl";
    return { kind, owner: String(a.ownership?.owner ?? "") };
  }
  const info = await connection.getAccountInfo(new PublicKey(nft));
  if (!info) throw new Error("asset has no account and no DAS RPC configured — cannot resolve (compressed?)");
  if (info.owner.equals(CORE_PROG))
    return { kind: "core", owner: new PublicKey(info.data.subarray(1, 33)).toBase58() };
  // classic mint: owner = holder of the ATA with amount 1 — resolve via largest accounts
  const largest = await connection.getTokenLargestAccounts(new PublicKey(nft));
  const holder = largest.value.find((v) => Number(v.amount) === 1);
  if (!holder) return { kind: "spl", owner: "" };
  const acc = await connection.getParsedAccountInfo(holder.address);
  return { kind: "spl", owner: String((acc.value?.data as any)?.parsed?.info?.owner ?? "") };
}

export async function ownsAsset(nft: string): Promise<boolean> {
  try {
    return (await assetInfo(nft)).owner === walletPk.toBase58();
  } catch {
    // last resort: the old ATA check (classic NFTs only)
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(nft), walletPk, true);
      return (await getAccount(connection, ata)).amount === 1n;
    } catch { return false; }
  }
}

/** Send the prize. Dispatches on standard; returns the tx signature. */
export async function transferAsset(nft: string, to: string): Promise<string> {
  const info = await assetInfo(nft);
  if (info.owner !== walletPk.toBase58()) throw new Error(`we don't own ${nft.slice(0, 8)} (owner ${info.owner.slice(0, 8)})`);
  const toPk = new PublicKey(to);
  const label = `prize ${info.kind} ${nft.slice(0, 8)} → ${to.slice(0, 8)}`;

  if (info.kind === "spl") {
    const mint = new PublicKey(nft);
    const from = getAssociatedTokenAddressSync(mint, walletPk, true);
    const dest = getAssociatedTokenAddressSync(mint, toPk, true);
    return sendTx([
      createAssociatedTokenAccountIdempotentInstruction(walletPk, dest, toPk, mint),
      createTransferCheckedInstruction(from, mint, dest, walletPk, 1n, 0),
    ], label);
  }

  if (info.kind === "core") {
    // MPL Core TransferV1: discriminator 14, arg Option<CompressionProof> = None.
    // Optional accounts omitted are passed as the mpl-core program id.
    const asset = await das("getAsset", { id: nft }).catch(() => null);
    const collection = asset?.grouping?.find((g: any) => g.group_key === "collection")?.group_value;
    const keys: AccountMeta[] = [
      { pubkey: new PublicKey(nft), isSigner: false, isWritable: true }, // asset
      { pubkey: collection ? new PublicKey(collection) : CORE_PROG, isSigner: false, isWritable: false },
      { pubkey: walletPk, isSigner: true, isWritable: true }, // payer
      { pubkey: CORE_PROG, isSigner: false, isWritable: false }, // authority omitted → payer
      { pubkey: toPk, isSigner: false, isWritable: false }, // new owner
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: CORE_PROG, isSigner: false, isWritable: false }, // log wrapper omitted
    ];
    return sendTx([new TransactionInstruction({ programId: CORE_PROG, keys, data: Buffer.from([14, 0]) })], label);
  }

  // compressed: proof + leaf data from DAS, then bubblegum transfer / transfer_v2
  const [a, proof] = await Promise.all([das("getAsset", { id: nft }), das("getAssetProof", { id: nft })]);
  const tree = new PublicKey(proof.tree_id);
  const treeConfig = PublicKey.findProgramAddressSync([tree.toBuffer()], BGUM_PROG)[0];
  const proofMetas: AccountMeta[] = proof.proof.map((p: string) => ({ pubkey: new PublicKey(p), isSigner: false, isWritable: false }));
  const root = Buffer.from(new PublicKey(proof.root).toBytes());
  const dataHash = Buffer.from(new PublicKey(a.compression.data_hash).toBytes());
  const creatorHash = Buffer.from(new PublicKey(a.compression.creator_hash).toBytes());
  const nonce = BigInt(a.compression.leaf_id);
  const index = Number(a.compression.leaf_id);

  if (info.kind === "cnft-v2") {
    // transfer_v2: disc [119,40,6,235,234,221,248,49] + root + dataHash +
    // creatorHash + Option<assetDataHash>=0 + Option<flags>=0 + nonce + index
    const data = Buffer.concat([
      Buffer.from([119, 40, 6, 235, 234, 221, 248, 49]),
      root, dataHash, creatorHash, Buffer.from([0, 0]),
      (() => { const b = Buffer.alloc(12); b.writeBigUInt64LE(nonce, 0); b.writeUInt32LE(index, 8); return b; })(),
    ]);
    const collection = a.grouping?.find((g: any) => g.group_key === "collection")?.group_value;
    const keys: AccountMeta[] = [
      { pubkey: treeConfig, isSigner: false, isWritable: true },
      { pubkey: walletPk, isSigner: true, isWritable: true }, // payer
      { pubkey: walletPk, isSigner: true, isWritable: false }, // authority (leaf owner)
      { pubkey: walletPk, isSigner: false, isWritable: false }, // leaf owner
      { pubkey: BGUM_PROG, isSigner: false, isWritable: false }, // leaf delegate omitted
      { pubkey: toPk, isSigner: false, isWritable: false }, // new leaf owner
      { pubkey: tree, isSigner: false, isWritable: true },
      { pubkey: collection ? new PublicKey(collection) : BGUM_PROG, isSigner: false, isWritable: false }, // core collection
      { pubkey: NOOP_V2, isSigner: false, isWritable: false },
      { pubkey: COMPRESSION_V2, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...proofMetas,
    ];
    return sendTx([new TransactionInstruction({ programId: BGUM_PROG, keys, data })], label);
  }

  // cnft-v1: anchor "global:transfer" + root + dataHash + creatorHash + nonce + index
  const disc = crypto.createHash("sha256").update("global:transfer").digest().subarray(0, 8);
  const tail = Buffer.alloc(12);
  tail.writeBigUInt64LE(nonce, 0);
  tail.writeUInt32LE(index, 8);
  const data = Buffer.concat([disc, root, dataHash, creatorHash, tail]);
  const keys: AccountMeta[] = [
    { pubkey: treeConfig, isSigner: false, isWritable: false }, // tree authority
    { pubkey: walletPk, isSigner: true, isWritable: false }, // leaf owner
    { pubkey: walletPk, isSigner: false, isWritable: false }, // leaf delegate
    { pubkey: toPk, isSigner: false, isWritable: false }, // new leaf owner
    { pubkey: tree, isSigner: false, isWritable: true },
    { pubkey: NOOP_V1, isSigner: false, isWritable: false },
    { pubkey: COMPRESSION_V1, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...proofMetas,
  ];
  return sendTx([new TransactionInstruction({ programId: BGUM_PROG, keys, data })], label);
}

/** Loud self-description for logs/receipts. */
export async function describeAsset(nft: string): Promise<string> {
  try {
    const i = await assetInfo(nft);
    return `${i.kind} owned by ${i.owner.slice(0, 8)}…`;
  } catch (e) {
    return `unresolved (${String(e).slice(0, 60)})`;
  }
}
