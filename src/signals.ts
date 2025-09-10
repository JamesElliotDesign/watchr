import fs from "fs/promises";
import path from "path";

export interface Signal {
  ts: number;
  wallet: string;
  mint: string;
  amount: number;          // tracked wallet's token amount seen (not trading size)
  entryPriceUsd?: number;
  symbol?: string | null;
  status: "open" | "closed";
  stopLossPct: number;
  source?: "birdeye" | "onchain";
  updatedTs?: number;
  occurrences?: number;
  closedTs?: number;
  closeReason?: string;

  // === Trader fields (our bot's own position tracking) ===
  trader?: {
    buySigs?: string[];           // Jupiter tx signatures for buys
    sellSigs?: string[];          // Jupiter tx signatures for sells
    solSpent?: number;            // approx SOL spent
  };

  // exit info (auto-close)
  exitPriceUsd?: number;
  exitPnlPct?: number;     // (exit - entry) / entry
}

const SIGNALS_FILE = path.resolve("signals.json");
const MERGE_WINDOW_MS = 60 * 1000; // 60s

export async function loadSignals(): Promise<Signal[]> {
  try {
    const raw = await fs.readFile(SIGNALS_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as Signal[]) : [];
  } catch {
    return [];
  }
}

export async function saveSignals(list: Signal[]): Promise<void> {
  await fs.writeFile(SIGNALS_FILE, JSON.stringify(list, null, 2), "utf8");
}

/** ✅ Helper: is there already an OPEN signal for this mint (across any wallet)? */
export async function hasOpenSignalForMint(mint: string): Promise<boolean> {
  const list = await loadSignals();
  return list.some((s) => s.status === "open" && s.mint === mint);
}

/** VWAP helper */
function mergeVWAP(prevAmount: number, prevPrice: number | undefined, addAmount: number, addPrice: number | undefined) {
  if (!prevPrice && !addPrice) return undefined;
  if (!prevPrice && addPrice) return addPrice;
  if (prevPrice && !addPrice) return prevPrice;
  const total = prevAmount + addAmount;
  if (total <= 0) return prevPrice!;
  return (prevPrice! * prevAmount + addPrice! * addAmount) / total;
}

export async function upsertBuy(params: {
  wallet: string;
  mint: string;
  amount: number;
  stopLossPct: number;
  source?: "birdeye" | "onchain";
  priceUsd?: number | null;
  symbol?: string | null;
}): Promise<Signal> {
  const { wallet, mint, amount, stopLossPct, source, priceUsd, symbol } = params;
  const now = Date.now();
  const list = await loadSignals();

  const idx = list.findIndex((s) => s.status === "open" && s.wallet === wallet && s.mint === mint);
  if (idx >= 0) {
    const s = list[idx];
    const last = s.updatedTs ?? s.ts;
    if (now - last <= MERGE_WINDOW_MS) {
      s.entryPriceUsd = mergeVWAP(s.amount, s.entryPriceUsd, amount, priceUsd ?? undefined);
      s.amount += amount;
      s.updatedTs = now;
      s.occurrences = (s.occurrences ?? 1) + 1;
      if (symbol && !s.symbol) s.symbol = symbol;
      if (source && !s.source) s.source = source;
      list[idx] = s;
      await saveSignals(list);
      return s;
    }
  }

  const newSig: Signal = {
    ts: now,
    wallet,
    mint,
    amount,
    entryPriceUsd: priceUsd ?? undefined,
    symbol: symbol ?? null,
    status: "open",
    stopLossPct,
    source,
    updatedTs: now,
    occurrences: 1,
  };
  list.push(newSig);
  await saveSignals(list);
  return newSig;
}

export async function attachTraderBuy(sig: Signal, jupSig: string, solSpent?: number): Promise<void> {
  const list = await loadSignals();
  const i = list.findIndex((x) => x.ts === sig.ts && x.wallet === sig.wallet && x.mint === sig.mint && x.status === sig.status);
  if (i >= 0) {
    list[i].trader = list[i].trader || {};
    list[i].trader!.buySigs = [...(list[i].trader!.buySigs || []), jupSig];
    if (typeof solSpent === "number") {
      list[i].trader!.solSpent = (list[i].trader!.solSpent || 0) + solSpent;
    }
    await saveSignals(list);
  }
}

export async function attachTraderSell(sig: Signal, jupSig: string): Promise<void> {
  const list = await loadSignals();
  const i = list.findIndex((x) => x.ts === sig.ts && x.wallet === sig.wallet && x.mint === sig.mint);
  if (i >= 0) {
    list[i].trader = list[i].trader || {};
    list[i].trader!.sellSigs = [...(list[i].trader!.sellSigs || []), jupSig];
    await saveSignals(list);
  }
}

export async function closeByWalletAndMint(params: { wallet: string; mint: string; reason?: string }): Promise<number> {
  const { wallet, mint, reason = "sold_by_wallet" } = params;
  const list = await loadSignals();
  let closed = 0;
  for (const s of list) {
    if (s.status === "open" && s.wallet === wallet && s.mint === mint) {
      s.status = "closed";
      s.closedTs = Date.now();
      s.closeReason = reason;
      closed++;
    }
  }
  if (closed > 0) await saveSignals(list);
  return closed;
}

export async function closeByWalletMintWithExit(params: {
  wallet: string; mint: string; exitPriceUsd: number; reason: "stop_loss" | "take_profit" | string;
}): Promise<number> {
  const { wallet, mint, exitPriceUsd, reason } = params;
  const list = await loadSignals();
  let closed = 0;
  for (const s of list) {
    if (s.status === "open" && s.wallet === wallet && s.mint === mint) {
      s.status = "closed";
      s.closedTs = Date.now();
      s.closeReason = reason;
      s.exitPriceUsd = exitPriceUsd;
      if (typeof s.entryPriceUsd === "number" && s.entryPriceUsd > 0) {
        s.exitPnlPct = (exitPriceUsd - s.entryPriceUsd) / s.entryPriceUsd;
      }
      closed++;
    }
  }
  if (closed > 0) await saveSignals(list);
  return closed;
}

/** ✅ Re-added: update stopLossPct for all OPEN signals */
export async function updateOpenSignalsStopLoss(newPct: number): Promise<number> {
  const list = await loadSignals();
  let changed = 0;
  for (const s of list) {
    if (s.status === "open" && s.stopLossPct !== newPct) {
      s.stopLossPct = newPct;
      changed++;
    }
  }
  if (changed > 0) await saveSignals(list);
  return changed;
}
