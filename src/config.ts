import dotenv from "dotenv";
dotenv.config();

export const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
export const ST_API_KEY = process.env.ST_API_KEY || "";
export const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || "";

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
export const WEBHOOK_URL = process.env.WEBHOOK_URL || "";
export const PORT = Number(process.env.PORT || 3000);

// Who can control the bot (Telegram numeric user id as string)
export const TELEGRAM_ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID || "";

// Initial defaults (can be changed at runtime via /set)
export const DEFAULT_PRICECHECK_INTERVAL_MS = Number(process.env.PRICECHECK_INTERVAL_MS || 15000);
export const DEFAULT_TAKE_PROFIT_PCT =
  process.env.TAKE_PROFIT_PCT !== undefined ? Number(process.env.TAKE_PROFIT_PCT) : NaN;
export const DEFAULT_STOP_LOSS_PCT = -0.8; // -80%

export const AUTO_TRADE = String(process.env.AUTO_TRADE || "false").toLowerCase() === "true";
// Private key of the bot wallet (base58 or JSON array string)
export const TRADER_PRIVATE_KEY = process.env.TRADER_PRIVATE_KEY || "";
// Budget per buy in SOL
export const TRADE_SOL_BUDGET = Number(process.env.TRADE_SOL_BUDGET || 0.05); // default 0.05 SOL
// Slippage in basis points (200 = 2%)
export const JUP_SLIPPAGE_BPS = Number(process.env.JUP_SLIPPAGE_BPS || 200);

// Route quality guards
export const MAX_SLIPPAGE_BPS = Number(process.env.MAX_SLIPPAGE_BPS || 1100); // 11% cap
export const MAX_PRICE_IMPACT_BPS = Number(process.env.MAX_PRICE_IMPACT_BPS || 1500); // 15%
export const MIN_OUT_USD = Number(process.env.MIN_OUT_USD || 3);

// Optional fixed priority fee (lamports). If unset -> "auto"
export const PRIORITY_FEE_LAMPORTS =
  process.env.PRIORITY_FEE_LAMPORTS && !Number.isNaN(Number(process.env.PRIORITY_FEE_LAMPORTS))
    ? Number(process.env.PRIORITY_FEE_LAMPORTS)
    : null;

// Jupiter Quote API base
export const JUP_BASE = "https://quote-api.jup.ag/v6";
// Use SOL as base (wrapped/unwrap automatically)
export const SOL_MINT = "So11111111111111111111111111111111111111112";
