import fetch from "node-fetch";
import { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import {
  HELIUS_API_KEY,
  TRADER_PRIVATE_KEY,
  JUP_BASE,
  SOL_MINT,
  JUP_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MAX_PRICE_IMPACT_BPS,
  PRIORITY_FEE_LAMPORTS,
} from "./config.js";
import { fetchInit, timeout } from "./http.js";

const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

function parseKeypair(): Keypair {
  if (!TRADER_PRIVATE_KEY) throw new Error("TRADER_PRIVATE_KEY missing");
  try {
    if (TRADER_PRIVATE_KEY.trim().startsWith("[")) {
      const arr = JSON.parse(TRADER_PRIVATE_KEY);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(TRADER_PRIVATE_KEY.trim()));
  } catch (e: any) {
    throw new Error(`Invalid TRADER_PRIVATE_KEY: ${e?.message || e}`);
  }
}

const conn = new Connection(RPC, "confirmed");
const wallet = parseKeypair();

export function traderPubkey(): string {
  return wallet.publicKey.toBase58();
}

/** Low-level: fetch a quote (typed any on purpose) */
async function getQuote(params: {
  inputMint: string; outputMint: string; amount: string; slippageBps?: number; swapMode?: "ExactIn" | "ExactOut";
}): Promise<any> {
  const q = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: String(params.slippageBps ?? JUP_SLIPPAGE_BPS),
    swapMode: params.swapMode ?? "ExactIn",
    onlyDirectRoutes: "false",
  }).toString();
  const res = await fetch(`${JUP_BASE}/quote?${q}`, fetchInit({ signal: timeout(1500) }));
  if (!res.ok) throw new Error(`JUP quote ${res.status}`);
  return res.json() as any;
}

/** Retry + re-quote helper (typed any on purpose) */
async function safeQuote(
  args: { inputMint: string; outputMint: string; amount: string; slippageBps?: number; swapMode?: "ExactIn" | "ExactOut" },
  tries = 2,
  slippage = JUP_SLIPPAGE_BPS
): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await getQuote({ ...args, slippageBps: slippage });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw lastErr;
}

/** Execute JUP swap from a quote (with timeout + keep-alive). */
async function executeSwap(quoteResponse: any, options?: { wrapUnwrapSOL?: boolean }) {
  const body = {
    quoteResponse,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapUnwrapSOL: options?.wrapUnwrapSOL ?? true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: PRIORITY_FEE_LAMPORTS ?? "auto",
  };
  const res = await fetch(`${JUP_BASE}/swap`, fetchInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(4000),
  }));
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`JUP swap ${res.status}: ${t.slice(0, 400)}`);
  }
  const j: any = await res.json();
  const swapTx = j?.swapTransaction;
  if (!swapTx) throw new Error("No swapTransaction");
  const buf = Buffer.from(swapTx, "base64");
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([wallet]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

/** Route quality checks */
function routeViable(quote: any): boolean {
  if (!quote) return false;
  const rp = Array.isArray(quote.routePlan) ? quote.routePlan.length : 0;
  if (rp <= 0) return false;

  const impactBps = Math.round((quote.priceImpactPct || 0) * 10000);
  if (impactBps > MAX_PRICE_IMPACT_BPS) return false;

  return true;
}

/** BUY: spend X SOL to acquire `mint` with robustness */
export async function buyTokenWithSol(mint: string, solBudget: number) {
  const lamports = BigInt(Math.floor(solBudget * LAMPORTS_PER_SOL));
  let quote: any = await safeQuote({
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: lamports.toString(),
    slippageBps: JUP_SLIPPAGE_BPS,
    swapMode: "ExactIn",
  });

  if (!routeViable(quote)) {
    const bump = Math.min(MAX_SLIPPAGE_BPS, JUP_SLIPPAGE_BPS + 300);
    quote = await safeQuote({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: lamports.toString(),
      slippageBps: bump,
      swapMode: "ExactIn",
    });
    if (!routeViable(quote)) throw new Error("no_viable_route");
  }

  try {
    return await executeSwap(quote, { wrapUnwrapSOL: true });
  } catch (e) {
    const bump = Math.min(MAX_SLIPPAGE_BPS, (quote.slippageBps ?? JUP_SLIPPAGE_BPS) + 300);
    if (bump > (quote.slippageBps ?? JUP_SLIPPAGE_BPS)) {
      const re: any = await safeQuote({
        inputMint: SOL_MINT,
        outputMint: mint,
        amount: lamports.toString(),
        slippageBps: bump,
        swapMode: "ExactIn",
      });
      return await executeSwap(re, { wrapUnwrapSOL: true });
    }
    throw e;
  }
}

/** SELL: sell `tokenAmountUnits` of `mint` back to SOL (robust) */
export async function sellTokenForSol(mint: string, tokenAmountUnits: bigint) {
  let quote: any = await safeQuote({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: tokenAmountUnits.toString(),
    slippageBps: JUP_SLIPPAGE_BPS,
    swapMode: "ExactIn",
  });

  if (!routeViable(quote)) {
    const bump = Math.min(MAX_SLIPPAGE_BPS, JUP_SLIPPAGE_BPS + 300);
    quote = await safeQuote({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: tokenAmountUnits.toString(),
      slippageBps: bump,
      swapMode: "ExactIn",
    });
    if (!routeViable(quote)) throw new Error("no_viable_route");
  }

  try {
    return await executeSwap(quote, { wrapUnwrapSOL: true });
  } catch (e) {
    const bump = Math.min(MAX_SLIPPAGE_BPS, (quote.slippageBps ?? JUP_SLIPPAGE_BPS) + 300);
    if (bump > (quote.slippageBps ?? JUP_SLIPPAGE_BPS)) {
      const re: any = await safeQuote({
        inputMint: mint,
        outputMint: SOL_MINT,
        amount: tokenAmountUnits.toString(),
        slippageBps: bump,
        swapMode: "ExactIn",
      });
      return await executeSwap(re, { wrapUnwrapSOL: true });
    }
    throw e;
  }
}

/** Get token balance (base units) in the trader wallet for a given mint + decimals */
export async function getTokenBalance(mint: string): Promise<{ amount: bigint; decimals: number }> {
  const mintPk = new PublicKey(mint);
  const mi = await conn.getParsedAccountInfo(mintPk);
  const parsed: any = mi.value?.data;
  const decimals = parsed?.parsed?.info?.decimals ?? 0;

  const accs = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: mintPk });
  let total = 0n;
  for (const a of accs.value) {
    const ui: any = a.account.data?.parsed?.info;
    const raw = ui?.tokenAmount?.amount ?? "0";
    total += BigInt(raw);
  }
  return { amount: total, decimals };
}
