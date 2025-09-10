// src/trader.ts
import fetch from "node-fetch";
import {
  AUTO_TRADE,
  HELIUS_API_KEY,
  JUP_SLIPPAGE_BPS,
  TRADE_SOL_BUDGET,
  SOL_MINT,
  MAX_SLIPPAGE_BPS,
  JUP_PROBE_SOL,
} from "./config.js";
import { sendTelegram } from "./telegram.js";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Basic setup
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const connection = new Connection(RPC_URL, "confirmed");

// Trader wallet
const secret = process.env.TRADER_PRIVATE_KEY;
if (!secret) throw new Error("TRADER_PRIVATE_KEY not set");
const trader = (() => {
  try {
    if (secret.startsWith("[") || secret.includes(",")) {
      // assume array of numbers
      const arr = JSON.parse(secret);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    // assume base58
    return Keypair.fromSecretKey(bs58.decode(secret));
  } catch (e) {
    throw new Error("Invalid TRADER_PRIVATE_KEY format");
  }
})();

export function traderPubkey() {
  return trader.publicKey.toBase58();
}

// Helpers
function toLamports(sol: number) {
  return BigInt(Math.floor(sol * 1e9));
}
function fromLamports(l: bigint) {
  return Number(l) / 1e9;
}

type JupQuote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: any[];
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/* -------------------------------------------
   Robust Jupiter quote getter (v6)
   - Accepts both top-level and { data } shapes
   - Validates routePlan presence
-------------------------------------------- */
async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;           // string lamports / token base units
  slippageBps: number;
  onlyDirectRoutes?: boolean;
  maxAccounts?: number;
}): Promise<JupQuote | null> {
  const url = new URL("https://quote-api.jup.ag/v6/quote");
  url.searchParams.set("inputMint", params.inputMint);
  url.searchParams.set("outputMint", params.outputMint);
  url.searchParams.set("amount", params.amount);
  url.searchParams.set("slippageBps", String(params.slippageBps));
  if (params.onlyDirectRoutes != null) url.searchParams.set("onlyDirectRoutes", String(params.onlyDirectRoutes));
  if (params.maxAccounts != null) url.searchParams.set("maxAccounts", String(params.maxAccounts));

  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) return null;

  let j: any = null;
  try {
    j = await res.json();
  } catch {
    return null;
  }
  // Some responses are { data: {...} }, others are top-level {...}
  const payload = j?.data ?? j;

  // If an error shape appears, bail out
  if (payload?.error || payload?.message === "No route found") return null;

  // Validate it looks like a quote
  if (!payload || !Array.isArray(payload.routePlan) || payload.routePlan.length === 0) {
    return null;
  }

  return payload as JupQuote;
}

// Do a swap using Jupiter v6 swap endpoint
async function doSwap(quote: JupQuote): Promise<string> {
  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: trader.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      asLegacyTransaction: false,
      prioritizationFeeLamports: "auto",
    }),
  });

  if (!swapRes.ok) {
    const text = await swapRes.text();
    throw new Error(`swap http ${swapRes.status}: ${text}`);
  }
  const body: any = await swapRes.json();
  const swapTx = body?.swapTransaction;
  if (!swapTx) throw new Error("swap missing swapTransaction");

  // decode and sign
  const { VersionedTransaction } = await import("@solana/web3.js");
  const txBuf = Buffer.from(swapTx, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([trader]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

/** Get associated token balance (amount as bigint) */
export async function getTokenBalance(mint: string): Promise<{ amount: bigint; ata: PublicKey | null }> {
  const owner = trader.publicKey;
  if (mint === SOL_MINT) {
    const bal = await connection.getBalance(owner, "confirmed");
    return { amount: BigInt(bal), ata: null };
  }
  const { getAssociatedTokenAddress } = await import("@solana/spl-token");
  const mintPk = new PublicKey(mint);
  const ata = await getAssociatedTokenAddress(mintPk, owner, true);
  const acc = await connection.getTokenAccountBalance(ata).catch(() => null);
  const raw = acc?.value?.amount ? BigInt(acc.value.amount) : 0n;
  return { amount: raw, ata };
}

/* -----------------------------
   BUY: dedup + retry on noviableroute
------------------------------ */

// Per-mint buy lock to avoid double-buys on burst signals
const buyLocks = new Map<string, NodeJS.Timeout>();
function lockMint(mint: string, ms: number) {
  const t = buyLocks.get(mint);
  if (t) clearTimeout(t);
  buyLocks.set(
    mint,
    setTimeout(() => buyLocks.delete(mint), ms)
  );
}
function unlockMint(mint: string) {
  const t = buyLocks.get(mint);
  if (t) clearTimeout(t);
  buyLocks.delete(mint);
}
function isLocked(mint: string) {
  return buyLocks.has(mint);
}

/** BUY: spend ~solBudget SOL to acquire `mint` with retry logic */
export async function buyTokenWithSol(mint: string, solBudget: number): Promise<string> {
  if (!AUTO_TRADE) throw new Error("AUTO_TRADE is disabled");
  if (isLocked(mint)) throw new Error("buy lock active for this mint");

  const lamportsBudget = Math.max(1, Math.floor(solBudget * 1e9));
  const slippage = Math.min(MAX_SLIPPAGE_BPS, Math.max(JUP_SLIPPAGE_BPS || 200, 200));

  // backoff ~3 minutes total
  const delays = [5000, 7000, 8000, 10000, 12000, 15000, 15000, 15000, 15000, 15000];

  // Lock during retries
  lockMint(mint, delays.reduce((a, b) => a + b, 0) + 5000);

  try {
    let lastErr: any = null;

    for (let i = 0; i <= delays.length; i++) {
      try {
        // Try with our budget
        let q = await getQuote({
          inputMint: SOL_MINT,
          outputMint: mint,
          amount: String(lamportsBudget),
          slippageBps: slippage,
          maxAccounts: 64,
        });

        // If no route, probe with a *bigger* amount to discover path (then re-quote at budget)
        if (!q) {
          const probeLamports = Math.max(
            lamportsBudget,
            Math.floor((isFinite(JUP_PROBE_SOL as any) ? (JUP_PROBE_SOL as number) : 0.02) * 1e9)
          );
          const probe = await getQuote({
            inputMint: SOL_MINT,
            outputMint: mint,
            amount: String(probeLamports),
            slippageBps: slippage,
            maxAccounts: 64,
          }).catch(() => null);

          if (!probe) throw new Error("noviableroute");

          // route exists at probe size, re-quote at real budget
          q = await getQuote({
            inputMint: SOL_MINT,
            outputMint: mint,
            amount: String(lamportsBudget),
            slippageBps: slippage,
            maxAccounts: 64,
          });

          if (!q) throw new Error("noviableroute");
        }

        return await doSwap(q);
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message || err);
        const retryable =
          /noviableroute/i.test(msg) ||
          /429/.test(msg) ||
          /5\d\d/.test(msg) ||
          /deadline|timeout|fetch failed|EAI_AGAIN|ECONNRESET|ETIMEDOUT/i.test(msg);

        if (!retryable || i === delays.length) throw err;
        await new Promise((r) => setTimeout(r, delays[i]));
      }
    }

    throw lastErr ?? new Error("buy failed");
  } finally {
    unlockMint(mint);
  }
}

/* -----------------------------
   SELL: existing smart fallback
------------------------------ */

export async function sellTokenForSol(mint: string, amountRaw: bigint): Promise<string> {
  if (mint === SOL_MINT) throw new Error("nothing to sell: mint is SOL");
  if (amountRaw <= 0n) throw new Error("nothing to sell: zero balance");

  const tryDirect = async (amt: bigint, slip: number) => {
    const q = await getQuote({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: amt.toString(),
      slippageBps: slip,
      maxAccounts: 64,
    });
    if (!q) throw new Error("noviableroute");
    return await doSwap(q);
  };

  // step 1: slippage escalate (min 200, up to MAX_SLIPPAGE_BPS, capped by constant)
  const cap = Math.min(MAX_SLIPPAGE_BPS, 1100);
  const base = Math.max(JUP_SLIPPAGE_BPS || 200, 200);
  const slips = Array.from(new Set([base, 400, 700, 900, cap]));
  for (const s of slips) {
    try {
      return await tryDirect(amountRaw, s);
    } catch (e: any) {
      if (!/noviableroute/i.test(String(e?.message))) throw e;
    }
  }

  // step 2: try 95% size
  const ninetyFive = (amountRaw * 95n) / 100n;
  if (ninetyFive > 0n) {
    for (const s of slips) {
      try {
        return await tryDirect(ninetyFive, s);
      } catch (e: any) {
        if (!/noviableroute/i.test(String(e?.message))) throw e;
      }
    }
  }

  // step 3: token -> USDC, then USDC -> SOL (best effort)
  const toUSDC = async (amt: bigint, slip: number) => {
    const q = await getQuote({
      inputMint: mint,
      outputMint: USDC_MINT,
      amount: amt.toString(),
      slippageBps: slip,
      maxAccounts: 64,
    });
    if (!q) throw new Error("noviableroute");
    return await doSwap(q);
  };

  for (const s of slips) {
    try {
      const sig1 = await toUSDC(ninetyFive > 0n ? ninetyFive : amountRaw, s);
      // second hop
      const usdcBal = await getTokenBalance(USDC_MINT);
      if (usdcBal.amount > 0n) {
        try {
          const q2 = await getQuote({
            inputMint: USDC_MINT,
            outputMint: SOL_MINT,
            amount: usdcBal.amount.toString(),
            slippageBps: s,
            maxAccounts: 64,
          });
          if (q2) {
            const sig2 = await doSwap(q2);
            return `${sig1} , ${sig2}`;
          }
        } catch {
          // ignore second-hop errors
        }
      }
      return sig1; // at least sold to USDC
    } catch (e: any) {
      if (!/noviableroute/i.test(String(e?.message))) throw e;
    }
  }

  throw new Error("noviableroute: token illiquid or dust too small");
}
