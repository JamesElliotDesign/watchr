import fetch from "node-fetch";
import { HELIUS_API_KEY, ST_API_KEY, WEBHOOK_URL } from "./config.js";
import { sendTelegram } from "./telegram.js";
import { fetchInit, timeout } from "./http.js";

export interface Trader {
  wallet: string;
  realized: number;
  total: number;
  winPercentage: number;
}

export interface HeliusWebhook {
  webhookID: string;
  webhookURL: string;
  accountAddresses: string[];
  authHeader?: string;
  transactionTypes?: string[];
  webhookType?: "enhanced" | "raw";
}

const MAX_ADDRESSES_PER_WEBHOOK = 20;

/* ------------------------------ Helpers ------------------------------ */

function dedupeTraders(traders: Trader[]): { unique: Trader[]; dropped: number } {
  const seen = new Set<string>();
  const unique: Trader[] = [];
  for (const t of traders) {
    if (seen.has(t.wallet)) continue;
    seen.add(t.wallet);
    unique.push(t);
  }
  return { unique, dropped: traders.length - unique.length };
}

async function listHeliusWebhooks(): Promise<HeliusWebhook[]> {
  const url = `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`;
  const res = await fetch(url, fetchInit({ signal: timeout(3000) }));
  const data = await res.json();
  return Array.isArray(data) ? (data as HeliusWebhook[]) : [];
}

async function updateHeliusWebhook(
  webhookID: string,
  wallets: string[]
): Promise<{ ok: boolean; truncatedBy: number; body?: string }> {
  const trimmed = wallets.slice(0, MAX_ADDRESSES_PER_WEBHOOK);
  const truncatedBy = wallets.length - trimmed.length;

  const url = `https://api.helius.xyz/v0/webhooks/${webhookID}?api-key=${HELIUS_API_KEY}`;
  const resp = await fetch(
    url,
    fetchInit({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountAddresses: trimmed,
        webhookURL: WEBHOOK_URL,
        webhookType: "enhanced",
        transactionTypes: ["ANY"],
        authHeader: "my-secret",
      }),
      signal: timeout(3000),
    })
  );

  const body = await resp.text();
  if (!resp.ok) {
    console.error(`❌ Failed to update webhook ${webhookID}: ${resp.status} ${resp.statusText}\n${body}`);
  }
  return { ok: resp.ok, truncatedBy, body };
}

async function createHeliusWebhook(
  wallets: string[]
): Promise<{ ok: boolean; truncatedBy: number; body?: string }> {
  const trimmed = wallets.slice(0, MAX_ADDRESSES_PER_WEBHOOK);
  const truncatedBy = wallets.length - trimmed.length;

  const url = `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`;
  const resp = await fetch(
    url,
    fetchInit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountAddresses: trimmed,
        webhookURL: WEBHOOK_URL,
        webhookType: "enhanced",
        transactionTypes: ["ANY"],
        authHeader: "my-secret",
      }),
      signal: timeout(3000),
    })
  );

  const body = await resp.text();
  if (!resp.ok) {
    console.error(`❌ Failed to create webhook: ${resp.status} ${resp.statusText}\n${body}`);
  }
  return { ok: resp.ok, truncatedBy, body };
}

/* ----------------------------- Main job ----------------------------- */

export async function updateTopWallets(): Promise<Trader[]> {
  const stUrl = "https://data.solanatracker.io/top-traders/all?window=3d&sortBy=total&expandPnl=false&page=1";

  try {
    const res = await fetch(
      stUrl,
      fetchInit({
        headers: { "x-api-key": ST_API_KEY },
        signal: timeout(3000),
      })
    );
    if (!res.ok) {
      const txt = await res.text();
      await sendTelegram(`❌ SolanaTracker error ${res.status}\n${txt.slice(0, 500)}`);
      return [];
    }

    const data: any = await res.json();
    if (!Array.isArray(data?.wallets) || data.wallets.length === 0) {
      await sendTelegram("⚠️ No traders returned from SolanaTracker");
      return [];
    }

    let traders: Trader[] = data.wallets.map((item: any) => ({
      wallet: item.wallet,
      realized: item.summary?.realized ?? 0,
      total: item.summary?.total ?? 0,
      winPercentage: item.summary?.winPercentage ?? 0,
    }));

    traders = traders.slice(0, 10);

    const beforeCount = traders.length;
    const { unique, dropped: dupDropped } = dedupeTraders(traders);
    const kept = unique.slice(0, MAX_ADDRESSES_PER_WEBHOOK);
    const capDropped = unique.length - kept.length;

    if (kept.length === 0) {
      await sendTelegram("⚠️ No unique wallets to subscribe after dedupe/cap");
      return [];
    }

    const wallets = kept.map((t) => t.wallet);

    await sendTelegram(
      `🔄 Updating Helius webhook...\n• Candidates: ${beforeCount}\n• Duplicates dropped: ${dupDropped}\n• Cap dropped: ${capDropped}\n• Final kept: ${wallets.length}`
    );

    const hooks = await listHeliusWebhooks();

    let ok = false;
    if (hooks.length > 0) {
      const target = hooks[0];
      const { ok: putOk, truncatedBy, body } = await updateHeliusWebhook(target.webhookID, wallets);
      ok = putOk;
      if (!putOk) {
        await sendTelegram(`❌ Failed to update Helius webhook — see logs`);
        if (body) console.error("Helius PUT response body:", body);
      } else {
        if (truncatedBy > 0) {
          await sendTelegram(`ℹ️ Truncated wallet list by ${truncatedBy} for Helius webhook cap`);
        }
        await sendTelegram(`✅ Updated existing Helius webhook (${target.webhookID})`);
      }
    } else {
      const { ok: postOk, truncatedBy, body } = await createHeliusWebhook(wallets);
      ok = postOk;
      if (!postOk) {
        await sendTelegram(`❌ Failed to create Helius webhook — see logs`);
        if (body) console.error("Helius POST response body:", body);
      } else {
        if (truncatedBy > 0) {
          await sendTelegram(`ℹ️ Truncated wallet list by ${truncatedBy} for Helius webhook cap`);
        }
        await sendTelegram("✅ Created new Helius webhook");
      }
    }

    if (!ok) return [];
    return kept;
  } catch (err: any) {
    console.error("Error in updateTopWallets:", err);
    await sendTelegram(`❌ Error updating top wallets: ${err.message}`);
    return [];
  }
}
