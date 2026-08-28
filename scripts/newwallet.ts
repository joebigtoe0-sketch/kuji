import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Generate the machine's wallet BEFORE deploying, so the private key exists
 * somewhere you control rather than only on a server volume.
 *
 * The secret is written to a file and never printed — anything echoed to a
 * terminal ends up in scrollback, shell history, CI logs and screen shares.
 * Only the public address is shown, and that is the one you compare against
 * /admin after setting WALLET_SECRET, to prove the right key is loaded.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "data");           // gitignored
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "WALLET-SECRET.txt");

if (fs.existsSync(out)) {
  console.error(`\n  ${out} already exists.`);
  console.error("  Refusing to overwrite — move or delete it first if you really want a new wallet.\n");
  process.exit(1);
}

const kp = Keypair.generate();
const secret = bs58.encode(kp.secretKey);

fs.writeFileSync(out, `${secret}\n`, { mode: 0o600 });

console.log(`
  KUJI machine wallet created.

  PUBLIC ADDRESS   ${kp.publicKey.toBase58()}
    ^ fund this one, and check it matches what /admin shows after deploy

  The private key was written to:
    ${out}

  Next:
    1. Open that file, copy the single line, and set it in Railway as
       WALLET_SECRET  (Variables tab — treat it like a password)
    2. Import the same key into Phantom if you want to watch the wallet
       or move funds by hand later
    3. Back it up somewhere durable (password manager), then DELETE the file
    4. Send USDC (to snipe with) + ~0.05 SOL (fees) to the address above

  Do not paste this key into chat, a terminal, or a commit. data/ is
  gitignored, so the file will not be committed from here.
`);
