import {
  cacheAudioOnGoogleDrive,
  getCachedTelegramMessage,
} from "./audio-cache.ts";
import { ensureMp3Cached, prepareMp3Audio } from "./streaming.ts";

type BotConfig = {
  token: string;
  channelId: string;
  adminChatId?: string;
};

function channelId(): string | undefined {
  return (
    Deno.env.get("TELEGRAM_CACHE_CHANNEL_ID") ||
    Deno.env.get("TELEGRAM_CHANNEL_ID")
  )?.trim() || undefined;
}

function config(): BotConfig | null {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  const storageChannelId = channelId();
  if (!token || !storageChannelId) return null;
  return {
    token,
    channelId: storageChannelId,
    adminChatId: Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")?.trim() || undefined,
  };
}

function outputConfig(): BotConfig | null {
  const token = Deno.env.get("TELEGRAM_OUTPUT_BOT_TOKEN")?.trim();
  const storageChannelId = channelId();
  if (!token || !storageChannelId) return null;
  return {
    token,
    channelId: storageChannelId,
    adminChatId: Deno.env.get("TELEGRAM_ADMIN_CHAT_ID")?.trim() || undefined,
  };
}

async function telegramApi(
  token: string,
  method: string,
  body: unknown,
  timeoutMs = 35_000,
  signal?: AbortSignal,
): Promise<any | null> {
  try {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.ok ? data.result : null;
  } catch {
    return null;
  }
}

function parseVideoId(input: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    const id = url.hostname === "youtu.be"
      ? url.pathname.slice(1).split("/")[0]
      : url.searchParams.get("v") ||
        url.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function sendMessage(token: string, chatId: string | number, text: string): Promise<void> {
  await telegramApi(token, "sendMessage", { chat_id: chatId, text });
}

async function copyCachedMessage(
  token: string,
  chatId: string,
  channelId: string,
  messageId: number,
): Promise<boolean> {
  const startedAt = Date.now();
  const copied = await telegramApi(token, "copyMessage", {
    chat_id: chatId,
    from_chat_id: channelId,
    message_id: messageId,
  });
  console.log(JSON.stringify({
    event: "telegram_output",
    state: copied ? "sent" : "failed",
    chatId,
    messageId,
    durationMs: Date.now() - startedAt,
  }));
  return Boolean(copied);
}

function isAdmin(
  chatId: string,
  senderId: string,
  adminChatId?: string,
): boolean {
  return Boolean(adminChatId && (chatId === adminChatId || senderId === adminChatId));
}

async function handleAdminCommand(
  token: string,
  chatId: string,
  senderId: string,
  command: string,
  adminChatId?: string,
): Promise<boolean> {
  if (command !== "/ping" && command !== "/status" && command !== "/restart") {
    return false;
  }
  if (!isAdmin(chatId, senderId, adminChatId)) return true;

  if (command === "/ping") {
    await sendMessage(token, chatId, "pong — input/output bots online");
    return true;
  }

  if (command === "/status") {
    await sendMessage(
      token,
      chatId,
      `Zefron bot status: online\nInput bot: ${config() ? "enabled" : "disabled"}\nOutput bot: ${outputConfig() ? "enabled" : "disabled"}\nCache channel: configured`,
    );
    return true;
  }

  await sendMessage(token, chatId, "Restarting input/output bot polling...");
  restartTelegramBots();
  return true;
}

async function processUpdate(
  token: string,
  update: any,
  channelId: string,
  adminChatId?: string,
): Promise<void> {
  const message = update.message || update.channel_post;
  const text = String(message?.text || "").trim();
  if (!message || !text) return;

  const chatId = String(message.chat?.id || "");
  const senderId = String(message.from?.id || "");
  const [rawCommand, input] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];
  if (await handleAdminCommand(token, chatId, senderId, command, adminChatId)) return;
  if (command !== "/reload") return;

  // A configured admin may use the bot from a private chat. Without one,
  // accept only commands posted in the cache channel itself.
  if (adminChatId ? senderId !== adminChatId && chatId !== adminChatId : chatId !== channelId) {
    return;
  }

  const videoId = input ? parseVideoId(input) : null;
  if (!videoId) {
    await sendMessage(token, chatId, "Usage: /reload <YouTube video ID or URL>");
    return;
  }

  await sendMessage(token, chatId, `Reloading ${videoId}...`);
  const audio = await prepareMp3Audio(videoId, 45_000);
  if (!audio.success) {
    await sendMessage(token, chatId, `Reload failed: ${audio.error}`);
    return;
  }
  const cached = await cacheAudioOnGoogleDrive(videoId, audio, true, "mp3");
  await sendMessage(token, chatId, cached ? `Reloaded and cached ${videoId}.` : "Reload prepared, but cache upload failed.");
}

const outputDeliveryJobs = new Map<string, Promise<void>>();

async function deliverOutputSong(
  token: string,
  chatId: string,
  channelId: string,
  videoId: string,
): Promise<void> {
  let cached = await getCachedTelegramMessage(videoId, "mp3");
  if (!cached?.telegramMessageId) {
    await ensureMp3Cached(videoId, 45_000);
    cached = await getCachedTelegramMessage(videoId, "mp3");
  }

  if (!cached?.telegramMessageId) {
    await sendMessage(token, chatId, "Song cache nahi ho payi. Thodi der baad dobara try karein.");
    return;
  }

  const sent = await copyCachedMessage(
    token,
    chatId,
    channelId,
    cached.telegramMessageId,
  );
  if (!sent) {
    await sendMessage(
      token,
      chatId,
      "Song deliver nahi ho paya. Output bot ko storage channel ka access check karein.",
    );
  }
}

function queueOutputDelivery(
  token: string,
  chatId: string,
  channelId: string,
  videoId: string,
): boolean {
  const key = `${chatId}:${videoId}`;
  if (outputDeliveryJobs.has(key)) return false;
  const job = deliverOutputSong(token, chatId, channelId, videoId)
    .catch((err) => {
      console.warn("Telegram output delivery failed:", String(err).slice(0, 160));
    })
    .finally(() => {
      outputDeliveryJobs.delete(key);
    });
  outputDeliveryJobs.set(key, job);
  return true;
}

async function processOutputUpdate(
  token: string,
  update: any,
  channelId: string,
  adminChatId?: string,
): Promise<void> {
  const message = update.message;
  const text = String(message?.text || "").trim();
  if (!message || !text) return;

  const [rawCommand, input] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];
  const chatId = String(message.chat?.id || "");
  if (!chatId) return;
  const senderId = String(message.from?.id || "");
  if (await handleAdminCommand(token, chatId, senderId, command, adminChatId)) return;

  if (command === "/start" || command === "/help") {
    await sendMessage(token, chatId, "Song ke liye /song <YouTube ID ya URL> bhejein.");
    return;
  }
  if (command !== "/song" && command !== "/download") return;

  const videoId = input ? parseVideoId(input) : null;
  if (!videoId) {
    await sendMessage(token, chatId, "Usage: /song <YouTube video ID ya URL>");
    return;
  }

  const cached = await getCachedTelegramMessage(videoId, "mp3");
  if (cached?.telegramMessageId) {
    await copyCachedMessage(token, chatId, channelId, cached.telegramMessageId);
    return;
  }

  const queued = queueOutputDelivery(token, chatId, channelId, videoId);
  if (queued) {
    await sendMessage(token, chatId, "Song prepare ho raha hai. Ready hote hi yahin bhej dunga.");
  }
}

const botControllers = new Map<"input" | "output", AbortController>();
const botOffsets = new Map<"input" | "output", number>();

async function poll(
  current: BotConfig,
  role: "input" | "output",
  controller: AbortController,
): Promise<void> {
  let offset = botOffsets.get(role) ?? 0;
  console.log(`Telegram ${role} bot enabled`);

  while (!controller.signal.aborted) {
    const updates = await telegramApi(current.token, "getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message", "channel_post"],
    }, 35_000, controller.signal);
    if (controller.signal.aborted) return;
    if (Array.isArray(updates)) {
      for (const update of updates) {
        offset = Math.max(offset, Number(update.update_id || 0) + 1);
        botOffsets.set(role, offset);
        if (controller.signal.aborted) return;
        if (role === "input") {
          await processUpdate(current.token, update, current.channelId, current.adminChatId);
        } else {
          await processOutputUpdate(
            current.token,
            update,
            current.channelId,
            current.adminChatId,
          );
        }
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function startConfiguredTelegramBots(): void {
  for (const controller of botControllers.values()) controller.abort();
  botControllers.clear();

  const input = config();
  if (input) {
    const controller = new AbortController();
    botControllers.set("input", controller);
    void poll(input, "input", controller).catch((err) =>
      console.warn("Telegram input bot stopped:", String(err).slice(0, 160))
    );
  }

  const output = outputConfig();
  if (output) {
    const controller = new AbortController();
    botControllers.set("output", controller);
    void poll(output, "output", controller).catch((err) =>
      console.warn("Telegram output bot stopped:", String(err).slice(0, 160))
    );
  }
}

export function restartTelegramBots(): void {
  startConfiguredTelegramBots();
}

export function startTelegramBot(): void {
  startConfiguredTelegramBots();
}