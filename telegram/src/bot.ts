/** A bot's name in a URL, a secret path, a stream path and an agent path: `iterate_bot` is
 *  `iterate-bot`. It is made from the bot's username when the bot is connected. */
export const BOT_NAME: RegExp = /^[a-z0-9][a-z0-9-]{0,39}$/;

type Kv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(prefix?: string): Promise<{ keys: string[] }>;
};

/** The project, as this package uses it: what a config worker's `itx` already has. */
export type TelegramItx = {
  fetch(request: Request): Promise<Response>;
  /** The project's own kv: only the root has it (a sub-context's `kv` is denied by default). */
  kv: Kv;
  agents: { create(path: string): Promise<unknown> };
  secrets: {
    set(
      path: string,
      material: string | Record<string, string>,
      options: { urls: string[] },
    ): Promise<unknown>;
    delete(path: string): Promise<unknown>;
    verifyEquals(path: string, input: { value: string }): Promise<boolean>;
  };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** What a project's code is handed to run: `(call) => { using itx = this.getItx(); return call(itx); }` */
export type WithItx = <T>(call: (itx: TelegramItx) => T) => Promise<Awaited<T>>;

/** The stream each bot's updates are recorded on. */
export const streamOf = (bot: string): string => `/integrations/telegram/${bot}`;
/** Each bot's own state, in the project's kv: `telegram/<bot>/bot` (its id and username),
 *  `…/allowed/<user id>`, `…/pending/<user id>`, `…/invite/<code>`. */
export const keyOf = (bot: string, key: string): string => `telegram/${bot}/${key}`;
/** The names of the connected bots: kv `telegram/bots/<name>`. */
const BOTS = "telegram/bots/";

export type Person = { name: string; username?: string; at: string };
export type Pending = Person & { chatId: number; chatTitle?: string };
export type BotInfo = { id: number; username: string };

export const WELCOME = "You're in. Send me a message to get started.";
export const PRIVATE = "This bot is private. I have asked its owner to let you in.";

/** The token placeholder iterate's egress swaps for the real token on its way to api.telegram.org.
 *  Telegram puts the token in the URL path, and egress never reads a body, so it goes there. */
export const placeholder = (bot: string): string =>
  `getSecret("/secrets/telegram-${bot}", { field: "token" })`;

/** One Bot API call. `credential` is `placeholder(bot)`, or a token not yet stored. */
export async function api<T = unknown>(
  itx: Pick<TelegramItx, "fetch">,
  credential: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await itx.fetch(
    new Request(`https://api.telegram.org/bot${credential}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    }),
  );
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: T;
    description?: string;
    error?: string;
  } | null;
  if (!body?.ok)
    throw new Error(`${method}: ${body?.description ?? body?.error ?? `HTTP ${response.status}`}`);
  return body.result as T;
}

/** Say something in a chat; a person who blocked the bot, or a 429, must not fail the caller. */
export async function say(
  itx: Pick<TelegramItx, "fetch">,
  bot: string,
  chatId: number,
  text: string,
): Promise<void> {
  await api(itx, placeholder(bot), "sendMessage", { chat_id: chatId, text }).catch(() => undefined);
}

const hex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function readJson<T>(itx: TelegramItx, bot: string, key: string): Promise<T | null> {
  const value = await itx.kv.get(keyOf(bot, key));
  return value ? (JSON.parse(value) as T) : null;
}

export async function listBots(itx: TelegramItx): Promise<string[]> {
  return (await itx.kv.list(BOTS)).keys.map((key) => key.slice(BOTS.length));
}

/** Everyone under `prefix` (`allowed/` or `pending/`), with the user id from the key. */
export async function listPeople<T>(
  itx: TelegramItx,
  bot: string,
  prefix: string,
): Promise<(T & { id: string })[]> {
  const base = keyOf(bot, prefix);
  const people: (T & { id: string })[] = [];
  for (const key of (await itx.kv.list(base)).keys) {
    const value = await itx.kv.get(key);
    if (value) people.push({ ...(JSON.parse(value) as T), id: key.slice(base.length) });
  }
  return people;
}

/** Connect a bot from the token @BotFather gave: check it, keep it as a secret, make the webhook
 *  secret (kept, never shown), and register `webhookBase/<name>` with Telegram. Connecting the same
 *  bot again rotates the webhook secret. Answers the bot's name here. */
export async function connectBot(
  itx: TelegramItx,
  token: string,
  webhookBase: string,
): Promise<{ name: string; username: string }> {
  if (!/^\d+:[\w-]{20,}$/.test(token.trim()))
    throw new Error("That does not look like a bot token");
  const me = await api<{ id: number; username: string }>(itx, token.trim(), "getMe");
  const name = me.username
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!BOT_NAME.test(name)) throw new Error(`The username ${me.username} cannot be used`);
  await itx.secrets.set(
    `/secrets/telegram-${name}`,
    { token: token.trim() },
    { urls: ["https://api.telegram.org"] },
  );
  const secret = hex(32);
  // kept first, so a delivery that arrives the moment the webhook is set can be checked
  await itx.secrets.set(`/secrets/telegram-webhook-${name}`, secret, {
    urls: ["https://telegram.invalid"],
  });
  await api(itx, placeholder(name), "setWebhook", {
    url: `${webhookBase}/${name}`,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  await itx.kv.put(keyOf(name, "bot"), JSON.stringify({ id: me.id, username: me.username }));
  await itx.kv.put(`${BOTS}${name}`, me.username);
  return { name, username: me.username };
}

export async function disconnectBot(itx: TelegramItx, bot: string): Promise<void> {
  await api(itx, placeholder(bot), "deleteWebhook").catch(() => undefined);
  await itx.secrets.delete(`/secrets/telegram-${bot}`).catch(() => undefined);
  await itx.secrets.delete(`/secrets/telegram-webhook-${bot}`).catch(() => undefined);
  await itx.kv.delete(`${BOTS}${bot}`);
  await itx.kv.delete(keyOf(bot, "bot"));
}

/** Let a person talk to the bot, by the number (never the username, which can change hands). */
export async function allow(
  itx: TelegramItx,
  bot: string,
  id: string,
  person: Person,
): Promise<void> {
  await itx.kv.put(keyOf(bot, `allowed/${id}`), JSON.stringify(person));
  await itx.kv.delete(keyOf(bot, `pending/${id}`));
}

/** A one-time link: whoever opens it in Telegram and taps Start is let in. Good for a week. */
export async function makeInvite(itx: TelegramItx, bot: string): Promise<string> {
  const code = hex(16);
  await itx.kv.put(keyOf(bot, `invite/${code}`), String(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const info = await readJson<BotInfo>(itx, bot, "bot");
  return `https://t.me/${info?.username ?? ""}?start=${code}`;
}

/** Spend an invite: true if the code was good (and now is gone). */
export async function spendInvite(itx: TelegramItx, bot: string, code: string): Promise<boolean> {
  const expires = await itx.kv.get(keyOf(bot, `invite/${code}`));
  if (!expires) return false;
  await itx.kv.delete(keyOf(bot, `invite/${code}`));
  return Number(expires) > Date.now();
}
