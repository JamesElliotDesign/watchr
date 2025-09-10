import fetch from "node-fetch";
import { loadSignals, closeByWalletMintWithExit } from "./signals.js";
import { getSettings } from "./settings.js";
import { sendTelegram } from "./telegram.js";
import { AUTO_TRADE, BIRDEYE_API_KEY } from "./config.js";
import { getTokenBalance, sellTokenForSol } from "./trader.js";
import { fetchInit, timeout } from "./http.js";

// --- Birdeye public price endpoint ---
async function getPrice(mint: string): Promise<number | null> {
  try {
    const headers: Record<string, string> = { accept: "application/json", "x-chain": "solana" };
    if (BIRDEYE_API_KEY) headers["X-API-KEY"] = BIRDEYE_API_KEY;

    const res = await fetch(
      `https://public-api.birdeye.so/defi/price?address=${mint}`,
      fetchInit({ headers, signal: timeout(1200) })
    );
    if (!res.ok) return null;
    const j: any = await res.json();
    const price = j?.data?.value ?? j?.data?.price ?? j?.data;
    return typeof price === "number" ? price : null;
  } catch {
    return null;
  }
}

function fmtPct(p: number) {
  return `${(p * 100).toFixed(2)}%`;
}

function money(n?: number | null) {
  return typeof n === "number" ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}` : "n/a";
}

let timer: NodeJS.Timeout | null = null;

export function startPriceChecker() {
  if (timer) return; // already running

  const tick = async () => {
    try {
      const settings = await getSettings();
      const interval = Math.max(3000, Number(settings.pricecheckIntervalMs || 15000)); // min 3s

      const signals = await loadSignals();
      const open = signals.filter(
        (s) => s.status === "open" && typeof s.entryPriceUsd === "number" && s.entryPriceUsd! > 0
      );

      if (open.length > 0) {
        // Fetch prices for unique mints once
        const uniqueMints = Array.from(new Set(open.map((s) => s.mint)));
        const priceMap = new Map<string, number | null>();
        await Promise.all(
          uniqueMints.map(async (mint) => {
            const price = await getPrice(mint);
            priceMap.set(mint, price);
          })
        );

        // Evaluate each open signal
        for (const s of open) {
          const current = priceMap.get(s.mint);
          if (typeof current !== "number" || current <= 0) continue;

          const entry = s.entryPriceUsd!;
          const pnlPct = (current - entry) / entry;

          const tryAutoSell = async () => {
            if (!AUTO_TRADE) return false;
            try {
              const bal = await getTokenBalance(s.mint);
              if (bal.amount > 0n) {
                await sellTokenForSol(s.mint, bal.amount);
                return true;
              }
            } catch {
              // swallow auto-sell errors here
            }
            return false;
          };

          // Stop-loss check (per-signal)
          if (typeof s.stopLossPct === "number" && pnlPct <= s.stopLossPct) {
            const traded = await tryAutoSell();
            const closed = await closeByWalletMintWithExit({
              wallet: s.wallet,
              mint: s.mint,
              exitPriceUsd: current,
              reason: "stop_loss",
            });
            if (closed > 0) {
              const label = s.symbol ? `${s.symbol} (${s.mint})` : s.mint;
              const tag = traded ? "Auto-sell — Stop-loss" : "Close — Stop-loss";
              await sendTelegram(
                `🛑 ${tag}\n*${s.wallet}* | ${label}\nEntry ~${money(entry)} → Exit ~${money(current)} (${fmtPct(pnlPct)})`
              );
            }
            continue; // move to next signal
          }

          // Take-profit (global; optional)
          const tp = settings.takeProfitPct;
          if (typeof tp === "number" && !Number.isNaN(tp) && pnlPct >= tp) {
            const traded = await tryAutoSell();
            const closed = await closeByWalletMintWithExit({
              wallet: s.wallet,
              mint: s.mint,
              exitPriceUsd: current,
              reason: "take_profit",
            });
            if (closed > 0) {
              const label = s.symbol ? `${s.symbol} (${s.mint})` : s.mint;
              const tag = traded ? "Auto-sell — Take-profit" : "Close — Take-profit";
              await sendTelegram(
                `🎯 ${tag}\n*${s.wallet}* | ${label}\nEntry ~${money(entry)} → Exit ~${money(current)} (${fmtPct(pnlPct)})`
              );
            }
          }
        }
      }

      // schedule next run
      timer = setTimeout(tick, interval);
    } catch {
      timer = setTimeout(tick, 15000);
    }
  };

  timer = setTimeout(tick, 2000);
}

export function stopPriceChecker() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
