import {
  ACCOUNTS,
  APP_SECRET,
  CONNECTION,
  listAccounts,
  readApp,
  REMOVED,
  secretOf,
  type Account,
  type XItx,
} from "./app.js";

/** THE DASH'S INTEGRATIONS PAGE lists what a mind's packages register on its `/integrations`
 *  context (iterate/integrations): one card per package, and one row per connection under it. Both
 *  are set semantics: a change appends the whole card or row again, and a null row takes one away.
 *  The install hook registers everything again (`mind/worker-updated`), so a registry that was
 *  emptied, or is older than the package, heals at the next publish. */

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
export const WORKER_UPDATED = "events.iterate.com/mind/worker-updated";

/** What the platform appends when a secret is set or deleted: on the secret's own context,
 *  `/secrets/<name>` (`event.path`), and nowhere else. */
const SECRET_FACTS = new Set([
  "events.iterate.com/secret/set",
  "events.iterate.com/secret/deleted",
]);

/** The secret of an account that was deleted, by its connection: a `secret/deleted` on the secret's
 *  own context, `/secrets/own-x-<connection>`. Disconnect deletes it too, and then finds
 *  no account left; a deletion on the Dash, or anywhere else, leaves an account with no tokens,
 *  and its row goes (`registerGone`). */
export const goneConnectionOf = (event: {
  type: string;
  path: string;
  payload?: unknown;
}): string | null => {
  if (event.type !== "events.iterate.com/secret/deleted") return null;
  const { path } = event;
  const connection = typeof path === "string" ? path.slice(secretOf("").length) : "";
  return typeof path === "string" && path === secretOf(connection) && CONNECTION.test(connection)
    ? connection
    : null;
};

/** Whether an event is the client's secret set or deleted, on that secret's own context. A person saves the client on the
 *  Dash, never through this package, so this fact is the moment its card changes. */
export const isAppFact = (event: { type: string; path: string; payload?: unknown }): boolean =>
  SECRET_FACTS.has(event.type) && event.path === APP_SECRET;

/** The package's name on the Dash. */
const INTEGRATION = "x";

/** A string the registry takes: it refuses a row whose account or detail is over 200 characters. */
const fit = (text: string, max = 200): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** One registry fact. `key`, in the install hook, is made of the triggering event's path and
 *  offset, so a retry appends nothing new. A conflict on it means this event's registration landed
 *  already, perhaps with what was true then: what changed since appended its own, with no key. */
async function append(
  itx: XItx,
  type: string,
  payload: Record<string, unknown>,
  key?: string,
): Promise<void> {
  try {
    await itx
      .cd("/integrations")
      .append({ type, ...(key ? { idempotencyKey: key } : {}), payload });
  } catch (error) {
    if (!key || (error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
  }
}

/** Registers the card. Its status is the accounts', never the setup's: once an account is
 *  connected the card says so, whatever the catalog says of the client (an account keeps working
 *  with a client saved before the form asked for its ID). Before that it has no status, and its one
 *  button is the next step on the page at `slug`: the Dash draws it as the thing to do. */
export async function registerCard(itx: XItx, slug: string, key?: string): Promise<void> {
  const accounts = (await itx.kv.list(ACCOUNTS)).keys.length;
  const ready = accounts > 0 || Boolean(await readApp(itx));
  await append(
    itx,
    "events.iterate.com/integration/configured",
    {
      integration: INTEGRATION,
      card: {
        title: "X",
        description:
          "The mind's own X app: X's API as each connected account, with tokens the platform refreshes.",
        icon: "https://www.google.com/s2/favicons?domain=x.com&sz=64",
        ...(accounts > 0 && {
          status: { kind: "ok", text: accounts === 1 ? "Connected" : `${accounts} accounts` },
        }),
        actions: [
          {
            label: accounts > 0 ? "Add account" : ready ? "Connect an account" : "Set up",
            routingSlug: slug,
            path: "/",
          },
        ],
      },
    },
    key,
  );
}

/** One connection's row: the account's @username, and buttons to the page and to the account on
 *  X. A row that is well needs no words: the Dash shows its dot. */
const rowOf = (slug: string, account: Account) => {
  const username = /^@([A-Za-z0-9_]{1,15})$/.exec(account.account)?.[1];
  const manage = { label: "Manage", routingSlug: slug, path: "/" };
  return {
    account: fit(account.account),
    status: { kind: "ok" },
    actions: username ? [manage, { label: "Open", url: `https://x.com/${username}` }] : [manage],
  };
};

/** Sets a connection's row as the kv has it, or takes it away (null) when the kv has none. */
export async function registerRow(
  itx: XItx,
  slug: string,
  connection: string,
  key?: string,
): Promise<void> {
  const value = await itx.kv.get(`${ACCOUNTS}${connection}`);
  await append(
    itx,
    "events.iterate.com/integration/connection-configured",
    {
      integration: INTEGRATION,
      connection,
      row: value ? rowOf(slug, JSON.parse(value) as Account) : null,
    },
    key,
  );
}

/** Takes a removed connection's row away (`forget` left a tombstone), then the tombstone: it
 *  stands until the null row has landed, so a failure here leaves the removal to finish. */
export async function registerRemoval(
  itx: XItx,
  slug: string,
  connection: string,
  key?: string,
): Promise<void> {
  await append(
    itx,
    "events.iterate.com/integration/connection-configured",
    { integration: INTEGRATION, connection, row: null },
    key,
  );
  await itx.kv.delete(`${REMOVED}${connection}`);
}

/** An account whose secret is gone, here or anywhere: it has no tokens, so it goes, by the same
 *  tombstone as a disconnect. Nothing happens when the kv has no such account (Disconnect took it
 *  away already) or the secret is back (connected again). */
export async function registerGone(
  itx: XItx,
  slug: string,
  connection: string,
  at: string,
): Promise<void> {
  if (!(await itx.kv.get(`${ACCOUNTS}${connection}`))) return;
  if ((await itx.secrets.list()).some((secret) => secret.path === secretOf(connection))) return;
  await itx.kv.put(`${REMOVED}${connection}`, JSON.stringify({ at: new Date().toISOString() }));
  await itx.kv.delete(`${ACCOUNTS}${connection}`);
  await registerRemoval(itx, slug, connection, `x:registry:gone:${connection}:${at}`);
  await registerCard(itx, slug, `x:registry:${at}`);
}

/** The install hook's registration, each fact keyed by the triggering event (`at` is its path and
 *  offset), so a retry appends nothing new. First the removals that did not finish: a tombstone's
 *  kv entry goes if it is still there, then its null row, under a key of its own (the row's may be
 *  spent on this event already). Then each account whose secret the catalog no longer has: it goes
 *  the same way. Then the card, a row per account the kv keeps, and a null for each row the
 *  registry holds of an account the kv does not (`itx.integrations.list()`, where the mind has it). */
export async function registerAll(itx: XItx, slug: string, at: string): Promise<void> {
  for (const key of (await itx.kv.list(REMOVED)).keys) {
    const connection = key.slice(REMOVED.length);
    if (!CONNECTION.test(connection)) continue;
    await itx.kv.delete(`${ACCOUNTS}${connection}`);
    await registerRemoval(itx, slug, connection, `x:registry:removed:${connection}:${at}`);
  }
  const held = new Set((await itx.secrets.list()).map((secret) => secret.path));
  for (const { connection } of await listAccounts(itx))
    if (!held.has(secretOf(connection))) {
      await itx.kv.put(`${REMOVED}${connection}`, JSON.stringify({ at: new Date().toISOString() }));
      await itx.kv.delete(`${ACCOUNTS}${connection}`);
      await registerRemoval(itx, slug, connection, `x:registry:removed:${connection}:${at}`);
    }
  await registerCard(itx, slug, `x:registry:${at}`);
  const kept = new Set<string>();
  for (const { connection } of await listAccounts(itx)) {
    kept.add(connection);
    await registerRow(itx, slug, connection, `x:registry:${connection}:${at}`);
  }
  const registered = itx.integrations ? (await itx.integrations.list()).connections : {};
  for (const key of Object.keys(registered)) {
    const connection = key.slice(`${INTEGRATION}/`.length);
    if (key.startsWith(`${INTEGRATION}/`) && !kept.has(connection))
      await append(
        itx,
        "events.iterate.com/integration/connection-configured",
        { integration: INTEGRATION, connection, row: null },
        `x:registry:${connection}:${at}`,
      );
  }
}
