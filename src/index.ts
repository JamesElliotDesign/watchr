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
  hasOpenSignalForMint,
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

// --- tiny health check ---
app.get("/", (_req, res) => {
  res.type("text/plain").send("watchr OK");
});

function fmt(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
function money(n?: number | null) {
  return typeof n === "number"
    ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}`
    : "n/a";
}

/**
 * In-memory short-term idempotency guards
 * - Prevents duplicate processing of the *same* event (signature) and mint/side
 * - Prevents rapid re-buys of the same mint within a brief window (buy lock)
 */
const SEEN_TTL_MS = 5 * 60_000;    // keep event keys ~5 minutes
const BUY_LOCK_MS = 60_000;        // don't buy same mint again within 60s

const seenEventKeys = new Map<string, number>(); // key = `${signature}:${mint}:${side}`
const buyLocks = new Map<string, number>();      // mint -> expiresAt

function cleanMapsNow() {
  const now = Date.now();
  for (const [k, t] of seenEventKeys.entries()) if (now - t > SEEN_TTL_MS) seenEventKeys.delete(k);
  for (const [m, t] of buyLocks.entries()) if (now > t) buyLocks.delete(m);
}
setInterval(cleanMapsNow, 60_000).unref();

/**
 * Helius webhook handler
 * - Aggregate transfers by (actor, side, mint) per event → single BUY/SELL per mint
 * - Qualify and auto-buy once per mint (guarded)
 * - On SELL by tracked wallet, close signals and auto-sell remaining balance (with clear label)
 */
app.post("/helius-webhook", async (req: Request, res: Response) => {
  const raw = req.body;
  const events = Array.isArray(raw) ? raw : [raw];

  for (const e of events) {
    if (e?.type !== "SWAP" && e?.type !== "SWAP_EVENT") continue;

    const actor: string | undefined = e.feePayer || e.account || undefined;
    const signature: string | undefined = e.signature || e.txHash || e.sig || undefined;
    if (!actor) continue;

    // Aggregate amounts per mint for this actor
    const buys = new Map<string, number>();  // mint -> total amt to actor
    const sells = new Map<string, number>(); // mint -> total amt from actor

    const txfers: any[] = Array.isArray(e.tokenTransfers) ? e.tokenTransfers : [];
    for (const t of txfers) {
      const mint: string | undefined = t?.mint;
      const amt: number | undefined =
        typeof t?.tokenAmount === "number" ? t.tokenAmount : undefined;
      const to: string | undefined = t?.toUserAccount;
      const from: string | undefined = t?.fromUserAccount;

      if (!mint || !amt || amt === 0) continue;

      if (to === actor) {
        // BUY
        const prev = buys.get(mint) || 0;
        buys.set(mint, prev + amt);
      } else if (from === actor) {
        // SELL
        const prev = sells.get(mint) || 0;
        sells.set(mint, prev + amt);
      }
    }

    // ---- Handle BUYS (ignore SOL) once per mint, idempotent on (signature,mint,BUY) ----
    for (const [mint, amt] of buys.entries()) {
      if (mint === SOL_MINT) continue;
      if (!amt || amt === 0) continue;

      // Per-event de-dupe
      const side = "BUY";
      const key = signature ? `${signature}:${mint}:${side}` : `${actor}:${mint}:${side}:${Math.round(amt*1e6)}`;
      if (seenEventKeys.has(key)) continue;
      seenEventKeys.set(key, Date.now());

      // One-and-done guard: if already tracking this mint, skip
      if (await hasOpenSignalForMint(mint)) {
        await sendTelegram(`⚠️ Duplicate signal ignored — already tracking ${mint}`);
        continue;
      }

      // Buy lock to avoid near-simultaneous duplicates across events
      const lockUntil = buyLocks.get(mint) || 0;
      const now = Date.now();
      if (now < lockUntil) {
        await sendTelegram(`⏳ Skipped duplicate buy (lock) — ${mint}`);
        continue;
      }
      buyLocks.set(mint, now + BUY_LOCK_MS);

      // Qualify & snapshot
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

        // Auto-trade BUY (spend SOL to acquire token)
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

    // ---- Handle SELLS (ignore SOL) once per mint, idempotent on (signature,mint,SELL) ----
    for (const [mint, amt] of sells.entries()) {
      if (mint === SOL_MINT) continue;
      if (!amt || amt === 0) continue;

      const side = "SELL";
      const key = signature ? `${signature}:${mint}:${side}` : `${actor}:${mint}:${side}:${Math.round(amt*1e6)}`;
      if (seenEventKeys.has(key)) continue;
      seenEventKeys.set(key, Date.now());

      // Announce the tracked wallet's sell
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

            await sendTelegram(`🔁 Auto-sell — Wallet-copy\n\`${mint}\`\n🧾 ${jupSig}`);
          } else {
            await sendTelegram(`🔒 Close — Wallet-copy (no position)\n\`${mint}\``);
          }
        } catch (err: any) {
          await sendTelegram(
            `⚠️ Auto-sell (wallet-copy) failed for \`${mint}\`:\n${err?.message || err}`
          );
        }
      } else if (closed > 0) {
        await sendTelegram(`🔒 Close — Wallet-copy (auto-trade OFF)\n\`${mint}\``);
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
