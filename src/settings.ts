import fs from "fs/promises";
import path from "path";
import {
  DEFAULT_PRICECHECK_INTERVAL_MS,
  DEFAULT_TAKE_PROFIT_PCT,
  DEFAULT_STOP_LOSS_PCT,
} from "./config.js";

export interface Settings {
  stopLossPctDefault: number;        // e.g., -0.8
  takeProfitPct?: number | null;     // NaN/null/undefined => disabled
  pricecheckIntervalMs: number;      // e.g., 15000
}

const FILE = path.resolve("settings.json");

let cache: Settings | null = null;

const defaults: Settings = {
  stopLossPctDefault: DEFAULT_STOP_LOSS_PCT,
  takeProfitPct: Number.isNaN(DEFAULT_TAKE_PROFIT_PCT) ? null : DEFAULT_TAKE_PROFIT_PCT,
  pricecheckIntervalMs: DEFAULT_PRICECHECK_INTERVAL_MS,
};

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = { ...defaults, ...(parsed || {}) };
  } catch {
    cache = { ...defaults };
  }
  return cache!;
}

export async function saveSettings(s: Settings): Promise<void> {
  cache = { ...defaults, ...s };
  await fs.writeFile(FILE, JSON.stringify(cache, null, 2), "utf8");
}

export async function getSettings(): Promise<Settings> {
  return loadSettings();
}

export async function updateSettings(partial: Partial<Settings>): Promise<Settings> {
  const cur = await loadSettings();
  const next: Settings = {
    ...cur,
    ...partial,
  };
  await saveSettings(next);
  return next;
}
