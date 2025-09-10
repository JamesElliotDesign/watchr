import fetch from "node-fetch";
import {
  AUTO_TRADE,
  HELIUS_API_KEY,
  JUP_SLIPPAGE_BPS,
  TRADE_SOL_BUDGET,
  SOL_MINT,
} from "./config.js";
import { sendTelegram } from "./telegram.js";
import { PublicKey, Connection, Keypair, SystemProgram } from "@solana/web3.js";
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

// Generic Jupiter quote getter with flexible params
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
  const j: any = await res.json();
  if (!j || !j.data) return null;
  return j.data as JupQuote;
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
  const txBuf = Buffer.from(swapTx, "base64");
  const tx = (await import("@solana/web3.js")).VersionedTransaction.deserialize(txBuf);
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

/** BUY: spend ~solBudget SOL to acquire `mint` */
export async function buyTokenWithSol(mint: string, solBudget: number): Promise<string> {
  const lamports = toLamports(solBudget);
  // quote SOL -> mint
  const q1 = await getQuote({
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: lamports.toString(),
    slippageBps: Math.min(1100, Math.max(JUP_SLIPPAGE_BPS || 200, 200)), // ensure >=200 and cap 1100
    maxAccounts: 64,
  });
  if (!q1) throw new Error("noviableroute: quote not found (SOL->token)");
  return await doSwap(q1);
}

/** SELL: try token -> SOL with smart fallback */
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

  // 1) direct with your configured slippage (min 200), then up to 1100
  const slips = Array.from(new Set([Math.max(JUP_SLIPPAGE_BPS || 200, 200), 400, 700, 900, 1100]));
  for (const s of slips) {
    try {
      return await tryDirect(amountRaw, s);
    } catch (e: any) {
      if (!/noviableroute/i.test(String(e?.message))) {
        // Non-route error: bubble up
        throw e;
      }
      // else try next plan
    }
  }

  // 2) try 95% size in case of dust / constraints
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

  // 3) Two-hop fallback: token -> USDC, then USDC -> SOL
  const tryToUSDC = async (amt: bigint, slip: number) => {
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

  // 3a) token -> USDC
  for (const s of slips) {
    try {
      const sig1 = await tryToUSDC(ninetyFive > 0n ? ninetyFive : amountRaw, s);
      // 3b) sell USDC -> SOL (best effort)
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
        } catch (_) {
          // ignore second-hop errors, we still sold to USDC
        }
      }
      return sig1; // at least sold to USDC
    } catch (e: any) {
      if (!/noviableroute/i.test(String(e?.message))) throw e;
    }
  }

  throw new Error("noviableroute: token illiquid or dust too small");
}
