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
/** A disconnect whose null row has yet to land on the Dash: kv `telegram/removed/<name>`. No bot is
 *  called `removed`: a bot's username ends in `bot`. */
export const REMOVED = "telegram/removed/";

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
 *  Dash's Integrations page with links to `slug`'s page: the card first, since a row stands under
 *  its card alone. Connecting the same bot again rotates the webhook secret. Answers the bot's name
 *  here. */
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
    url: `${webhookBase}/webhook/${name}`,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  const info: BotInfo = {
    id: me.id,
    username: me.username,
    ...(me.first_name ? { name: me.first_name } : {}),
  };
  // connected again after a disconnect that did not finish: that disconnect is over
  await itx.kv.delete(`${REMOVED}${name}`);
  await itx.kv.put(keyOf(name, "bot"), JSON.stringify(info));
  await itx.kv.put(`${BOTS}${name}`, me.username);
  await registerCard(itx, slug);
  await registerBot(itx, name, slug);
  return { name, username: me.username };
}

/** Delete a secret. One that is already gone (`SECRET_NOT_SET`) is what was wanted; any other
 *  failure is thrown, so nothing reports a credential gone while it still works. */
async function dropSecret(itx: TelegramItx, path: string): Promise<void> {
  await itx.secrets.delete(path).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== "SECRET_NOT_SET") throw error;
  });
}

/** Whether a disconnect of `bot` has yet to finish (its tombstone stands). */
export async function removing(itx: TelegramItx, bot: string): Promise<boolean> {
  return (await itx.kv.get(`${REMOVED}${bot}`)) !== null;
}

/** Disconnect a bot: its webhook, its two secrets, its place in the list, and its row on the
 *  Dash's Integrations page. A secret that cannot be deleted is thrown, and the bot stays listed,
 *  so Disconnect again can work. From the moment the secrets are gone until the null row has
 *  landed, a tombstone, `telegram/removed/<bot>`, says what is left to do: Disconnect again
 *  finishes it, and so does the install hook. Who was let in stays, for a bot connected again. */
export async function disconnectBot(itx: TelegramItx, bot: string, slug: string): Promise<void> {
  await api(itx, placeholder(bot), "deleteWebhook").catch(() => undefined);
  await dropSecret(itx, `/secrets/telegram-${bot}`);
  await dropSecret(itx, `/secrets/telegram-webhook-${bot}`);
  await itx.kv.put(`${REMOVED}${bot}`, new Date().toISOString());
  await itx.kv.delete(`${BOTS}${bot}`);
  await itx.kv.delete(keyOf(bot, "bot"));
  await registerRemoval(itx, bot);
  await registerCard(itx, slug);
}

/** Takes a disconnected bot's row away, then its tombstone: it stands until the null row has
 *  landed, so a failure here leaves the disconnect to finish. */
async function registerRemoval(itx: TelegramItx, bot: string, key?: string): Promise<void> {
  await setRow(itx, INTEGRATION, bot, null, key);
  await itx.kv.delete(`${REMOVED}${bot}`);
}

/** The package's name on the Dash's Integrations page. */
const INTEGRATION = "telegram";

/** The card: whether a bot is connected, and the button to the page. */
const cardOf = (slug: string, connected: boolean): Card => ({
  title: "Telegram",
  description:
    "A Telegram bot for private chats and groups, each handed to an agent. Invite links let people in.",
  icon: "https://www.google.com/s2/favicons?domain=telegram.org&sz=64",
  status: connected ? { kind: "ok" } : { kind: "attention", text: "Connect a bot" },
  actions: [{ label: connected ? "Manage" : "Connect", routingSlug: slug, path: "/" }],
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
        { label: "Manage", routingSlug: slug, path: "/" },
        ...(username ? [{ label: "Open", url: `https://t.me/${username}` }] : []),
      ],
      details: { "Let in": people === 1 ? "1 person" : `${people} people` },
    },
    key,
  );
}

/** The install hook's registration, each fact keyed by the triggering event (`at` is its path and
 *  offset), so a retry appends nothing new. First the disconnects that did not finish: a tombstone's
 *  bot leaves the list if it is still there, then its null row lands, under a key of its own (the
 *  row's may be spent on this event already). Then the card, and a row per bot in the list. */
export async function registerAll(itx: TelegramItx, slug: string, at: string): Promise<void> {
  for (const key of (await itx.kv.list(REMOVED)).keys) {
    const bot = key.slice(REMOVED.length);
    if (!BOT_NAME.test(bot)) continue;
    await itx.kv.delete(`${BOTS}${bot}`);
    await itx.kv.delete(keyOf(bot, "bot"));
    await registerRemoval(itx, bot, `telegram:registry:removed:${bot}:${at}`);
  }
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
