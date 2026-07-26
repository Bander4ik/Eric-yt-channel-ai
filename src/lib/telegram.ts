import "server-only";
import { getSetting } from "./db";

/**
 * Minimal Telegram bot client. We only need `sendMessage` for alerts.
 *
 * Setup flow for the user:
 *   1. Open @BotFather on Telegram, run /newbot, get a bot token.
 *   2. Send /start to your new bot from your personal account.
 *   3. Visit https://api.telegram.org/bot<TOKEN>/getUpdates to find your
 *      chat_id (look for "chat":{"id":123...}).
 *   4. Paste both into the in-app Settings → Telegram card.
 *
 * We store both bot token and chat ID in `settings`. They aren't sensitive
 * enough to warrant separate encryption (bot tokens are only useful when
 * paired with a chat ID, and chat IDs are public-ish).
 */

const TELEGRAM_TOKEN_KEY = "telegram.botToken";
const TELEGRAM_CHAT_ID_KEY = "telegram.chatId";

export function isTelegramConfigured(): boolean {
  return !!getSetting(TELEGRAM_TOKEN_KEY) && !!getSetting(TELEGRAM_CHAT_ID_KEY);
}

export async function sendTelegramMessage(text: string): Promise<{ ok: boolean; error?: string }> {
  const token = getSetting(TELEGRAM_TOKEN_KEY);
  const chatId = getSetting(TELEGRAM_CHAT_ID_KEY);
  if (!token || !chatId) {
    return { ok: false, error: "Telegram not configured" };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // Keep formatting simple — Telegram's MarkdownV2 has finicky
        // escaping rules and we don't need rich text for alerts.
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Telegram ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "send failed" };
  }
}
