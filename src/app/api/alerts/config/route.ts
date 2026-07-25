import { NextResponse } from "next/server";
import { getAlertConfig, setAlertConfig, ensureRulesSeed } from "@/lib/alerts";
import { isTelegramConfigured, sendTelegramMessage } from "@/lib/telegram";
import { setSetting } from "@/lib/db";

export const runtime = "nodejs";

/** GET — master alert switch + Telegram readiness flag. Per-rule
 *  configuration moved to /api/alerts/rules. */
export async function GET() {
  ensureRulesSeed();
  return NextResponse.json({
    ...getAlertConfig(),
    telegramConfigured: isTelegramConfigured(),
  });
}

/**
 * POST — partial config update. Accepts:
 *   - `enabled` (bool) — master switch (any enabled rule will only fire
 *     when this is on; lets the user kill all alerts at once without
 *     touching individual rules).
 *   - `telegramBotToken` (string) — bot token from @BotFather
 *   - `telegramChatId` (string) — destination chat id
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<{
    enabled: boolean;
    telegramBotToken: string;
    telegramChatId: string;
  }>;

  if (typeof body.enabled === "boolean") {
    setAlertConfig({ enabled: body.enabled });
  }
  if (typeof body.telegramBotToken === "string") {
    setSetting("telegram.botToken", body.telegramBotToken.trim());
  }
  if (typeof body.telegramChatId === "string") {
    setSetting("telegram.chatId", body.telegramChatId.trim());
  }

  return NextResponse.json({
    ok: true,
    ...getAlertConfig(),
    telegramConfigured: isTelegramConfigured(),
  });
}

/**
 * Test endpoint — sends a "hello" message to the configured Telegram chat
 * so the user can confirm the bot is wired correctly before enabling
 * real alerts.
 */
export async function PUT() {
  const result = await sendTelegramMessage(
    "✅ <b>YouTube Channel AI VIP test</b>\n\nIf you can read this, your alerts are wired up correctly."
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
