import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import express, { Request, Response } from "express";
import {
  PORT,
  AUTO_TRADE,
  TRADE_SOL_BUDGET,
  SOL_MINT,
} from "./config.js";
import { sendTelegram, pollTelegramCommands } from "./telegram.js";
import { updateTopWallets, Trader } from "./jobs.js";
import { qualifyAndSnapshot } from "./qualifier.js";
import {
  upsertBuy,
  closeByWalletAndMint,
  loadSignals,
  updateOpenSignalsStopLoss,
  attachTraderBuy,
  attachTraderSell,
  hasOpenSignalForMint,          // ✅ new import
} from "./signals.js";
import { getSettings, updateSettings } from "./settings.js";
import { startPriceChecker } from "./pricecheck.js";
import {
  buyTokenWithSol,
  getTokenBalance,
  sellTokenForSol,
  traderPubkey,
} from "./trader.js";

const app = express();
app.use(express.json());

function fmt(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function money(n?: number | null) {
  return typeof n === "number"
    ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}`
    : "n/a";
}

/**
 * Helius webhook handler
 * - Qualify BUYs, enrich with price/symbol, upsert signals, auto-buy via Jupiter (SOL budget)
 * - On SELL by the tracked wallet, close signals and auto-sell remaining balance
 */
app.post("/helius-webhook", async (req: Request, res: Response) => {
  const raw = req.body;
  const events = Array.isArray(raw) ? raw : [raw];

  for (const e of events) {
    if (e?.type !== "SWAP" && e?.type !== "SWAP_EVENT") continue;

    const actor: string | undefined = e.feePayer || e.account || undefined;
    if (!actor) continue;

    const txfers: any[] = Array.isArray(e.tokenTransfers) ? e.tokenTransfers : [];
    for (const t of txfers) {
      const mint: string | undefined = t?.mint;
      const amt: number | undefined =
        typeof t?.tokenAmount === "number" ? t.tokenAmount : undefined;
      const to: string | undefined = t?.toUserAccount;
      const from: string | undefined = t?.fromUserAccount;

      if (!mint || !amt || amt === 0) continue;

      // ===== BUYs (ignore SOL) =====
      if (to === actor) {
        if (mint === SOL_MINT) continue;

        // ✅ One-and-done: if we already track an OPEN signal for this mint (any wallet), skip trade/noise
        if (await hasOpenSignalForMint(mint)) {
          await sendTelegram(`⚠️ Duplicate signal ignored — already tracking ${mint}`);
          continue;
        }

        const q = await qualifyAndSnapshot({ wallet: actor, mint, amount: amt });
        if (q.qualified) {
          const settings = await getSettings();
          const sig = await upsertBuy({
            wallet: actor,
            mint,
            amount: amt,
            stopLossPct: settings.stopLossPctDefault,
            source: q.source,
            priceUsd: q.snapshot?.priceUsd ?? null,
            symbol: q.snapshot?.symbol ?? null,
          });

          // Optional auto-trade BUY (spend SOL to acquire token)
          if (AUTO_TRADE) {
            try {
              const jupSig = await buyTokenWithSol(mint, TRADE_SOL_BUDGET);
              await attachTraderBuy(sig, jupSig, TRADE_SOL_BUDGET);
              await sendTelegram(
                `🛒 Auto-buy executed — ${sig.symbol ? `${sig.symbol} (${mint})` : mint}\n🔑 Trader: ${traderPubkey()}\n🧾 ${jupSig}`
              );
            } catch (err: any) {
              await sendTelegram(`⚠️ Auto-buy failed — \`${mint}\`\n${err?.message || err}`);
            }
          }

          const label = sig.symbol ? `${sig.symbol} (${mint})` : `\`${mint}\``;
          await sendTelegram(
            `✅ Qualified — *${actor}* got *${fmt(amt)}* of ${label} @ ~${money(q.snapshot?.priceUsd)}${
              sig.occurrences && sig.occurrences > 1 ? ` (x${sig.occurrences} merged)` : ""
            }`
          );
        } else {
          await sendTelegram(
            `❎ Not qualified — *${actor}* got *${fmt(amt)}* of \`${mint}\`${q.reason ? ` (${q.reason})` : ""}`
          );
        }
      }

      // ===== SELLs (ignore SOL) =====
      if (from === actor) {
        if (mint === SOL_MINT) continue;

        // Announce the wallet's sell first
        await sendTelegram(`📉 Sell — *${actor}* sent *${fmt(amt)}* of \`${mint}\``);

        const closed = await closeByWalletAndMint({
          wallet: actor,
          mint,
          reason: "sold_by_wallet",
        });

        // Auto-trade SELL: market-sell any remaining balance in trader wallet
        if (AUTO_TRADE && closed > 0) {
          try {
            const bal = await getTokenBalance(mint);
            if (bal.amount > 0n) {
              const jupSig = await sellTokenForSol(mint, bal.amount);
              const signals = await loadSignals();
              const recentClosed = signals.find(
                (s) => s.wallet === actor && s.mint === mint && s.status === "closed"
              );
              if (recentClosed) await attachTraderSell(recentClosed, jupSig);

              // ✅ Clear label: wallet-copy auto-sell
              await sendTelegram(`🔁 Auto-sell — Wallet-copy\n\`${mint}\`\n🧾 ${jupSig}`);
            } else {
              // No position; still label clearly
              await sendTelegram(`🔒 Close — Wallet-copy (no position)\n\`${mint}\``);
            }
          } catch (err: any) {
            await sendTelegram(
              `⚠️ Auto-sell (wallet-copy) failed for \`${mint}\`:\n${err?.message || err}`
            );
          }
        } else if (closed > 0) {
          // We closed signal but AUTO_TRADE is off
          await sendTelegram(`🔒 Close — Wallet-copy (auto-trade OFF)\n\`${mint}\``);
        }
      }
    }
  }

  res.send("ok");
});

app.listen(PORT, async () => {
  console.log(`watchr listening on port ${PORT}`);

  // start periodic price checker (handles stop-loss / take-profit and optional auto-sell)
  startPriceChecker();

  // Announce TP state on boot
  const s = await getSettings();
  if (s.takeProfitPct == null || Number.isNaN(s.takeProfitPct)) {
    await sendTelegram("ℹ️ Take-profit is *disabled*. Use `/set takeprofit 1.0` for +100%.");
  }

  // Telegram commands
  pollTelegramCommands(async ({ text }) => {
    if (text === "/fetch") {
      await sendTelegram("🔄 Fetching top wallets...");
      const traders: Trader[] = await updateTopWallets();
      if (traders.length > 0) {
        const list = traders
          .map(
            (t, i) =>
              `${i + 1}. \`${t.wallet}\` — Realized: *$${t.realized.toLocaleString(
                "en-US",
                { maximumFractionDigits: 2 }
              )}* | Total: *$${t.total.toLocaleString("en-US", {
                maximumFractionDigits: 2,
              })}* | Win%: *${t.winPercentage.toFixed(2)}*`
          )
          .join("\n");
        await sendTelegram(`✅ Subscribed to ${traders.length} wallets:\n${list}`);
      } else {
        await sendTelegram("⚠️ No wallets subscribed");
      }
      return;
    }

    if (text === "/signals") {
      const signals = await loadSignals();
      const open = signals.filter((s) => s.status === "open");
      if (open.length === 0) {
        await sendTelegram("📭 No open signals.");
      } else {
        const lines = open.slice(0, 20).map((s, i) => {
          const label = s.symbol ? `${s.symbol} (${s.mint})` : s.mint;
          const priceStr = s.entryPriceUsd
            ? `$${s.entryPriceUsd.toLocaleString("en-US", {
                maximumFractionDigits: 6,
              })}`
            : "n/a";
          return `${i + 1}. ${label} — *${fmt(
            s.amount
          )}* by *${s.wallet}* — entry ~${priceStr} — SL ${(
            s.stopLossPct * 100
          ).toFixed(0)}% — since ${new Date(s.ts).toLocaleString()}`;
        });
        const tail = open.length > 20 ? `\n…and ${open.length - 20} more` : "";
        await sendTelegram(`📈 Open signals (${open.length})\n${lines.join("\n")}${tail}`);
      }
      return;
    }

    if (text === "/settings") {
      const set = await getSettings();
      const tp =
        typeof set.takeProfitPct === "number" && !Number.isNaN(set.takeProfitPct)
          ? `${(set.takeProfitPct * 100).toFixed(2)}%`
          : "disabled";
      await sendTelegram(
        `⚙️ Settings\n• Stop Loss (default): ${(set.stopLossPctDefault * 100).toFixed(
          2
        )}%\n• Take Profit: ${tp}\n• Price Check Interval: ${set.pricecheckIntervalMs} ms\n• Auto-Trade: ${
          AUTO_TRADE ? "ON" : "OFF"
        }\n• Trader: ${traderPubkey()}`
      );
      return;
    }

    if (text.startsWith("/set ")) {
      const parts = text.split(/\s+/).map((p) => p.trim());
      if (parts.length < 3) {
        await sendTelegram("Usage:\n/set stoploss -0.8\n/set takeprofit 1.0\n/set interval 15000");
        return;
      }
      const key = parts[1].toLowerCase();
      const val = parts[2];

      if (key === "stoploss") {
        const n = Number(val);
        if (Number.isNaN(n) || n >= 0) {
          await sendTelegram("❌ stoploss must be a negative decimal (e.g., -0.8 for -80%).");
          return;
        }
        const next = await updateSettings({ stopLossPctDefault: n });
        const changed = await updateOpenSignalsStopLoss(n);
        await sendTelegram(
          `✅ Updated stopLoss default to ${(next.stopLossPctDefault * 100).toFixed(
            2
          )}%\n🔧 Applied to ${changed} open signal(s).`
        );
        return;
      }

      if (key === "takeprofit") {
        const n = Number(val);
        if (val.toLowerCase() === "off" || n === 0) {
          await updateSettings({ takeProfitPct: null });
          await sendTelegram(`✅ Updated takeProfit to disabled.`);
          return;
        }
        if (Number.isNaN(n)) {
          await sendTelegram("❌ takeprofit must be a number (e.g., 1.0 for +100%). Use 0 or 'off' to disable.");
          return;
        }
        const next = await updateSettings({ takeProfitPct: n });
        await sendTelegram(`✅ Updated takeProfit to ${(next.takeProfitPct! * 100).toFixed(2)}%.`);
        return;
      }

      if (key === "interval") {
        const n = Number(val);
        if (Number.isNaN(n) || n < 3000) {
          await sendTelegram("❌ interval must be a number >= 3000 (ms).");
          return;
        }
        const next = await updateSettings({ pricecheckIntervalMs: n });
        await sendTelegram(`✅ Updated price check interval to ${next.pricecheckIntervalMs} ms.`);
        return;
      }

      await sendTelegram("Unknown setting. Valid keys: stoploss, takeprofit, interval");
      return;
    }
  });
});
