import fetch from "node-fetch";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ALLOWED_USER_ID } from "./config.js";
import { fetchInit, timeout } from "./http.js";

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

export async function sendTelegram(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(
    `${API}/sendMessage`,
    fetchInit({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
      signal: timeout(5000),
    })
  );
}

type CommandHandler = (cmd: { text: string; fromId: string; chatId: string }) => Promise<void> | void;

let offset = 0;

export async function pollTelegramCommands(onCommand: CommandHandler) {
  if (!TELEGRAM_BOT_TOKEN) return;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(
        `${API}/getUpdates?offset=${offset > 0 ? offset : ""}&timeout=30`,
        fetchInit({ signal: timeout(35000) })
      );
      const j: any = await res.json();

      if (!j.ok) continue;

      for (const upd of j.result as any[]) {
        offset = upd.update_id + 1;

        const msg = upd.message || upd.edited_message;
        if (!msg || typeof msg.text !== "string") continue;

        const fromId = String(msg.from?.id ?? "");
        const chatId = String(msg.chat?.id ?? "");
        const text = msg.text.trim();

        if (TELEGRAM_ALLOWED_USER_ID && fromId !== TELEGRAM_ALLOWED_USER_ID) {
          continue;
        }

        if (!text.startsWith("/")) continue;
        await onCommand({ text, fromId, chatId });
      }
    } catch (err) {
      console.error("Telegram polling error:", err);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
