import fetch from "node-fetch";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  HELIUS_API_KEY,
  BIRDEYE_API_KEY,
  TRADE_SOL_BUDGET,
  JUP_BASE,
  JUP_SLIPPAGE_BPS,
  REQUIRE_JUP_ROUTE,
  JUP_PROBE_SOL,
} from "./config.js";
import { fetchInit, timeout } from "./http.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Known stablecoins on Solana (extend as needed)
const STABLECOIN_MINTS = new Set<string>([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERZ8i9hPq6qA4C2811aYkGf5Z9Wj9kRGwA", // USDT
]);

export type SafetyResult =
  | { safe: true; source: "birdeye" | "onchain"; details?: any }
  | { safe: false; source: "birdeye" | "onchain"; reason: string; details?: any };

export type Snapshot = {
  priceUsd?: number | null;
  symbol?: string | null;
  name?: string | null;
};

function isStablecoin(mint: string): boolean {
  return STABLECOIN_MINTS.has(mint);
}

function heliusConnection(): Connection {
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  return new Connection(rpcUrl, "confirmed");
}

/** Birdeye public token security */
async function birdeyeSecurityCheck(mint: string): Promise<SafetyResult> {
  const url = `https://public-api.birdeye.so/defi/token_security?address=${mint}`;
  const headers: Record<string, string> = { accept: "application/json", "x-chain": "solana" };
  if (BIRDEYE_API_KEY) headers["X-API-KEY"] = BIRDEYE_API_KEY;

  const res = await fetch(url, fetchInit({ headers, signal: timeout(1200) }));
  if (!res.ok) {
    const txt = await res.text();
    return { safe: false, source: "birdeye", reason: `http_${res.status}`, details: txt.slice(0, 500) };
  }

  const json: any = await res.json();
  const data = json?.data ?? {};

  if (data?.isHoneypot === true) return { safe: false, source: "birdeye", reason: "honeypot" };
  if (data?.freeze === true || data?.freezeable === true || data?.freezeAuthority)
    return { safe: false, source: "birdeye", reason: "freeze_authority_present" };
  if (data?.nonTransferable === true) return { safe: false, source: "birdeye", reason: "non_transferable" };
  if (data?.transferFeeEnable === true) return { safe: false, source: "birdeye", reason: "transfer_fee_enabled" };

  return { safe: true, source: "birdeye", details: { jupStrictList: data?.jupStrictList ?? null } };
}

/** On-chain minimal safety checks via RPC (fallback) */
async function onchainSafetyCheck(mint: string): Promise<SafetyResult> {
  try {
    const conn = heliusConnection();
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const parsed: any = info.value?.data;
    const mintInfo = parsed?.parsed?.info;

    const freezeAuthority = mintInfo?.freezeAuthority ?? null;
    const mintAuthority = mintInfo?.mintAuthority ?? null;
    const isToken2022 =
      parsed?.parsed?.type === "mint" && Array.isArray(mintInfo?.extensions) && mintInfo.extensions.length > 0;

    if (freezeAuthority) return { safe: false, source: "onchain", reason: "freeze_authority_present", details: { freezeAuthority } };
    if (mintAuthority) return { safe: false, source: "onchain", reason: "mint_authority_present", details: { mintAuthority } };
    if (isToken2022) return { safe: false, source: "onchain", reason: "token2022_risk", details: { isToken2022 } };

    return { safe: true, source: "onchain", details: { freezeAuthority, mintAuthority, isToken2022 } };
  } catch (e: any) {
    return { safe: false, source: "onchain", reason: `rpc_error: ${e?.message || e}` };
  }
}

/** Birdeye price snapshot (public) */
async function birdeyePrice(mint: string): Promise<number | null> {
  try {
    const url = `https://public-api.birdeye.so/defi/price?address=${mint}`;
    const headers: Record<string, string> = { accept: "application/json", "x-chain": "solana" };
    if (BIRDEYE_API_KEY) headers["X-API-KEY"] = BIRDEYE_API_KEY;

    const res = await fetch(url, fetchInit({ headers, signal: timeout(1200) }));
    if (!res.ok) return null;
    const j: any = await res.json();
    const price = j?.data?.value ?? j?.data?.price ?? j?.data;
    return typeof price === "number" ? price : null;
  } catch {
    return null;
  }
}

/** Birdeye metadata snapshot (symbol/name) — public v3 single */
async function birdeyeMeta(mint: string): Promise<{ symbol?: string | null; name?: string | null }> {
  try {
    const url = `https://public-api.birdeye.so/defi/v3/token/meta-data/single?address=${mint}`;
    const headers: Record<string, string> = { accept: "application/json", "x-chain": "solana" };
    if (BIRDEYE_API_KEY) headers["X-API-KEY"] = BIRDEYE_API_KEY;

    const res = await fetch(url, fetchInit({ headers, signal: timeout(1200) }));
    if (!res.ok) return {};
    const j: any = await res.json();
    const d = j?.data;
    return { symbol: d?.symbol ?? null, name: d?.name ?? null };
  } catch {
    return {};
  }
}

/** Quick viability check: does Jupiter have a route for (max of budget/probe) right now? */
async function jupHasRoute(mint: string): Promise<boolean> {
  try {
    const baseSol = Math.max(TRADE_SOL_BUDGET, isFinite(JUP_PROBE_SOL) ? JUP_PROBE_SOL : 0.02);
    const lamports = Math.floor(baseSol * 1_000_000_000);
    const q = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: String(lamports),
      slippageBps: String(Math.min(1100, Math.max(JUP_SLIPPAGE_BPS || 200, 200))),
      swapMode: "ExactIn",
      onlyDirectRoutes: "false",
      maxAccounts: "64",
    }).toString();
    const res = await fetch(`${JUP_BASE}/quote?${q}`, fetchInit({ signal: timeout(1200) }));
    if (!res.ok) return false;
    const data: any = await res.json();
    const out = Number(data?.outAmount ?? 0);
    // Some responses are wrapped; also check routePlan length as another signal
    const routed = out > 0 || (Array.isArray(data?.routePlan) && data.routePlan.length > 0);
    return routed;
  } catch {
    return false;
  }
}

/** Public API: qualify-only + snapshot (no file writes) */
export async function qualifyAndSnapshot(params: {
  wallet: string; mint: string; amount: number;
}): Promise<{ qualified: boolean; reason?: string; source?: "birdeye" | "onchain"; snapshot?: { priceUsd?: number | null; symbol?: string | null; name?: string | null } }> {
  const { mint } = params;

  // 1) Ignore SOL & stablecoins
  if (mint === SOL_MINT) return { qualified: false, reason: "sol_ignored" };
  if (isStablecoin(mint)) return { qualified: false, reason: "stablecoin_ignored" };

  // 2) Run safety first
  let safety: SafetyResult;
  try {
    safety = await birdeyeSecurityCheck(mint);
    if (!safety.safe && (safety as any).reason?.startsWith("http_")) {
      safety = await onchainSafetyCheck(mint);
    }
  } catch {
    safety = await onchainSafetyCheck(mint);
  }
  if (!safety.safe) return { qualified: false, reason: safety.reason, source: safety.source };

  // 3) Price/meta (don’t block on failure)
  const [priceUsd, meta] = await Promise.all([birdeyePrice(mint), birdeyeMeta(mint)]);

  // 4) Route gating (configurable)
  if (REQUIRE_JUP_ROUTE) {
    const routable = await jupHasRoute(mint);
    if (!routable) return { qualified: false, reason: "no_route" };
  }

  return {
    qualified: true,
    source: safety.source,
    snapshot: { priceUsd: priceUsd ?? null, symbol: meta.symbol ?? null, name: meta.name ?? null },
  };
}
