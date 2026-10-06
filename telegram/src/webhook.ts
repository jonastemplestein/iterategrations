import {
  allow,
  api,
  BOT_NAME,
  placeholder,
  PRIVATE,
  readJson,
  say,
  spendInvite,
  keyOf,
  streamOf,
  WELCOME,
  type BotInfo,
  type Pending,
  type TelegramItx,
  type WithItx,
} from "./bot.js";

type Message = {
  message_id: number;
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
  chat: { id: number; type: string; title?: string };
  message_thread_id?: number;
  text?: string;
  caption?: string;
  reply_to_message?: { from?: { id: number } };
  [media: string]: unknown;
};

/** Files a message can carry; `photo` is a list of sizes, the largest last. */
const FILES = ["photo", "document", "voice", "audio", "video", "video_note", "sticker"];

/** Whether a group message is for the bot: it @mentions the bot, replies to it, or is a command. */
export function isAddressed(message: Message, bot: BotInfo): boolean {
  const text = message.text ?? message.caption ?? "";
  return (
    text.toLowerCase().includes(`@${bot.username.toLowerCase()}`) ||
    message.reply_to_message?.from?.id === bot.id ||
    text.startsWith("/")
  );
}

/** What the agent is told: where, who, what, the files, and how to answer. An agent writes scripts
 *  against `itx`, which cannot import packages, so the answer is a plain `itx.fetch` with the
 *  token placeholder. */
function describe(bot: string, info: BotInfo, message: Message): string {
  const group = message.chat.type !== "private";
  const files = FILES.flatMap((kind) => {
    const found = message[kind];
    const file = (Array.isArray(found) ? found.at(-1) : found) as { file_id?: string } | undefined;
    return file?.file_id ? [`Attached: ${kind}, file_id ${file.file_id}`] : [];
  });
  const who = `${message.from?.first_name ?? "someone"}${message.from?.username ? ` (@${message.from.username})` : ""}`;
  const where = group ? ` in the group "${message.chat.title ?? message.chat.id}"` : "";
  const thread = message.message_thread_id
    ? `, message_thread_id: ${message.message_thread_id}`
    : "";
  const reply = group ? `, reply_parameters: { message_id: ${message.message_id} }` : "";
  return [
    `Telegram message from ${who}${where}:`,
    message.text ?? message.caption ?? "(no text)",
    ...files,
    `Reply with \`await itx.fetch(new Request('https://api.telegram.org/bot' + '${placeholder(bot)}' + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: ${message.chat.id}${thread}${reply}, text }) }))\`. A message holds at most 4096 characters. Any other Bot API method is the same call under its own name. To read a file, call getFile with its file_id, then GET 'https://api.telegram.org/file/bot' + '${placeholder(bot)}' + '/' + file_path (up to 20 MB).${group ? ` You are @${info.username}. In a group, answer only what is meant for you; the rest you read as context.` : ""}`,
  ].join("\n\n");
}

/** An append that was already made is not an error: Telegram resends, and so does a retry. */
const once = (append: Promise<unknown>): Promise<unknown> =>
  append.catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
  });

async function route(itx: TelegramItx, bot: string, id: number, message: Message): Promise<void> {
  const from = message.from;
  const info = await readJson<BotInfo>(itx, bot, "bot");
  if (!from || from.is_bot || !info) return;
  const group = message.chat.type !== "private";
  const person = {
    name: from.first_name ?? String(from.id),
    ...(from.username ? { username: from.username } : {}),
    at: new Date().toISOString(),
  };
  const text = message.text?.trim() ?? "";

  // an invite: `/start <code>` from a person opening a link in a private chat
  const code = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text)?.[1];
  if (!group && code !== undefined && (await spendInvite(itx, bot, code))) {
    await allow(itx, bot, String(from.id), person);
    await say(itx, bot, message.chat.id, WELCOME);
    return;
  }

  const allowed = await itx.kv.get(keyOf(bot, `allowed/${from.id}`));
  const addressed = !group || isAddressed(message, info);
  if (!allowed) {
    // Only what is meant for the bot counts, so a group's chatter fills no list. A person is told
    // once, in private; the owner sees them on the Telegram page and lets them in.
    if (!addressed) return;
    const known = await itx.kv.get(keyOf(bot, `pending/${from.id}`));
    const pending: Pending = {
      ...person,
      chatId: message.chat.id,
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
    };
    await itx.kv.put(keyOf(bot, `pending/${from.id}`), JSON.stringify(pending));
    if (!known && !group) await say(itx, bot, message.chat.id, PRIVATE);
    return;
  }
  if (!group && /^\/start(?:@\w+)?$/.test(text)) {
    await say(itx, bot, message.chat.id, WELCOME);
    return;
  }

  // One agent per chat. What is meant for the bot wakes it, with "typing" in the chat meanwhile;
  // the rest of a group's talk it reads as context only.
  const agent = `/agents/telegram/${bot}/chat-${message.chat.id}`;
  await Promise.all([
    itx.agents.create(agent),
    addressed
      ? api(itx, placeholder(bot), "sendChatAction", {
          chat_id: message.chat.id,
          action: "typing",
          ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
        }).catch(() => undefined)
      : undefined,
  ]);
  await once(
    itx.cd(agent).append({
      type: "events.iterate.com/agent/context-added",
      idempotencyKey: `telegram:${bot}:${id}`,
      payload: {
        role: "user",
        actor: { type: "user" },
        content: describe(bot, info, message),
        ...(addressed ? {} : { llmRequestPolicy: { behaviour: "dont-trigger-request" } }),
      },
    }),
  );
}

/** Telegram's webhook. It POSTs one `Update` to the URL given to `setWebhook`, with the
 *  `secret_token` chosen there in the header `X-Telegram-Bot-Api-Secret-Token`, and resends until it
 *  gets a 2xx. The URL is `/<bot>`; the token is checked against `/secrets/telegram-webhook-<bot>`
 *  with `itx.secrets.verifyEquals`. An unknown bot or a wrong token looks like any other path: a 404
 *  that stores nothing. Each update is recorded as `telegram/update`, keyed by `update_id`; then
 *  `route` decides what it means. */
export async function receiveUpdate(request: Request, withItx: WithItx): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  const [, bot = ""] = new URL(request.url).pathname.split("/").map(decodeURIComponent);
  const presented = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  const known =
    BOT_NAME.test(bot) &&
    presented !== "" &&
    (await withItx((itx) =>
      itx.secrets.verifyEquals(`/secrets/telegram-webhook-${bot}`, { value: presented }),
    ));
  if (!known) return new Response("Not found\n", { status: 404 });

  // authenticated: what cannot be used is acknowledged, so Telegram stops resending it
  const update = (await request.json().catch(() => null)) as {
    update_id?: unknown;
    message?: Message;
  } | null;
  if (typeof update?.update_id !== "number")
    return Response.json({ ok: true, ignored: update ? "no update_id" : "not JSON" });
  const id = update.update_id;
  await withItx(async (itx) => {
    await once(
      itx.cd(streamOf(bot)).append({
        type: "telegram/update",
        idempotencyKey: `telegram:${bot}:${id}`,
        payload: { bot, update },
      }),
    );
    if (update.message) await route(itx, bot, id, update.message);
  });
  return Response.json({ ok: true });
}
