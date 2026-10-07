import { setCard, setRow, type Card } from "./registry.js";

/** A bot's name in a URL, a secret path, a stream path and an agent path: `iterate_bot` is
 *  `iterate-bot`. It is made from the bot's username when the bot is connected. It is also the
 *  bot's connection on the Dash's Integrations page. */
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
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** The agents app's root, which the default delivery uses: the project installs the app
 *  (`installAgents`, as the default template does). `TelegramItx` leaves it out because the scope
 *  a worker hands a package is typed without installed apps (iterate/api `IterateContextApiWith`). */
export type AgentsItx = { agents: { create(path: string): Promise<unknown> } };

/** The stream each bot's updates are recorded on. */
export const streamOf = (bot: string): string => `/integrations/telegram/${bot}`;
/** Each bot's own state, in the project's kv: `telegram/<bot>/bot` (its id and username),
 *  `…/allowed/<user id>`, `…/pending/<user id>`, `…/invite/<code>`. */
export const keyOf = (bot: string, key: string): string => `telegram/${bot}/${key}`;
/** The names of the connected bots: kv `telegram/bots/<name>`. */
const BOTS = "telegram/bots/";

export type Person = { name: string; username?: string; at: string };
export type Pending = Person & { chatId: number; chatTitle?: string };
/** `name` is the bot's display name ("Jeeves"); a bot connected before it was kept has none. */
export type BotInfo = { id: number; username: string; name?: string };

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

/** A text message holds at most 4096 characters. */
export const MESSAGE_LIMIT = 4096;

/** `text` in pieces of at most `limit` characters, cut at a blank line, a line end or a space where
 *  one is near, and never inside a surrogate pair. For a sender that carries long answers. */
export function splitText(text: string, limit: number = MESSAGE_LIMIT): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    let cut = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"), head.lastIndexOf(" "));
    if (cut < limit / 2) cut = limit;
    const last = rest.charCodeAt(cut - 1);
    if (cut === limit && last >= 0xd800 && last <= 0xdbff) cut -= 1; // a high surrogate: keep the pair whole
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest !== "" || pieces.length === 0) pieces.push(rest);
  return pieces;
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
 *  secret (kept, never shown), register `webhookBase/<name>` with Telegram, and list the bot on the
 *  Dash's Integrations page with links to `slug`'s page. Connecting the same bot again rotates the
 *  webhook secret. Answers the bot's name here. */
export async function connectBot(
  itx: TelegramItx,
  token: string,
  webhookBase: string,
  slug: string,
): Promise<{ name: string; username: string }> {
  if (!/^\d+:[\w-]{20,}$/.test(token.trim()))
    throw new Error("That does not look like a bot token");
  const me = await api<{ id: number; username: string; first_name?: string }>(
    itx,
    token.trim(),
    "getMe",
  );
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
  const info: BotInfo = {
    id: me.id,
    username: me.username,
    ...(me.first_name ? { name: me.first_name } : {}),
  };
  await itx.kv.put(keyOf(name, "bot"), JSON.stringify(info));
  await itx.kv.put(`${BOTS}${name}`, me.username);
  await registerBot(itx, name, slug);
  await registerCard(itx, slug);
  return { name, username: me.username };
}

/** Disconnect a bot: its webhook, its two secrets, its place in the list, and its row on the
 *  Dash's Integrations page. Who was let in stays, for a bot connected again. */
export async function disconnectBot(itx: TelegramItx, bot: string, slug: string): Promise<void> {
  await api(itx, placeholder(bot), "deleteWebhook").catch(() => undefined);
  await itx.secrets.delete(`/secrets/telegram-${bot}`).catch(() => undefined);
  await itx.secrets.delete(`/secrets/telegram-webhook-${bot}`).catch(() => undefined);
  await itx.kv.delete(`${BOTS}${bot}`);
  await itx.kv.delete(keyOf(bot, "bot"));
  await setRow(itx, INTEGRATION, bot, null);
  await registerCard(itx, slug);
}

/** The package's name on the Dash's Integrations page. */
const INTEGRATION = "telegram";

/** The card: whether a bot is connected, and the button to the page. */
const cardOf = (slug: string, connected: boolean): Card => ({
  title: "Telegram",
  description:
    "A Telegram bot for private chats and groups, each handed to an agent. Invite links let people in.",
  status: connected ? { kind: "ok" } : { kind: "attention", text: "Connect a bot" },
  actions: [{ label: connected ? "Manage" : "Connect", routingSlug: slug, path: "/_/" }],
});

/** Registers the card, as the connected bots make it. */
export async function registerCard(itx: TelegramItx, slug: string, key?: string): Promise<void> {
  await setCard(itx, INTEGRATION, cardOf(slug, (await listBots(itx)).length > 0), key);
}

/** Sets a connected bot's row: its username, a link to the page and one to the bot, and how many
 *  people are let in. */
export async function registerBot(
  itx: TelegramItx,
  bot: string,
  slug: string,
  key?: string,
): Promise<void> {
  const username = (await readJson<BotInfo>(itx, bot, "bot"))?.username;
  const people = (await itx.kv.list(keyOf(bot, "allowed/"))).keys.length;
  await setRow(
    itx,
    INTEGRATION,
    bot,
    {
      account: `@${username ?? bot}`,
      status: { kind: "ok" },
      actions: [
        { label: "Manage", routingSlug: slug, path: "/_/" },
        ...(username ? [{ label: "Open", url: `https://t.me/${username}` }] : []),
      ],
      details: { "Let in": people === 1 ? "1 person" : `${people} people` },
    },
    key,
  );
}

/** The install hook's registration: the card and a row per bot in the list, each keyed by the
 *  triggering event (`at` is its path and offset), so a retry appends nothing new. */
export async function registerAll(itx: TelegramItx, slug: string, at: string): Promise<void> {
  await registerCard(itx, slug, `telegram:registry:${at}`);
  for (const bot of await listBots(itx))
    await registerBot(itx, bot, slug, `telegram:registry:${bot}:${at}`);
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
