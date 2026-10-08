import {
  ACCOUNTS,
  CONNECTION,
  hasAppSecret,
  listAccounts,
  readApp,
  REMOVED,
  scopesShown,
  type Account,
  type GoogleItx,
} from "./app.js";

/** THE DASH'S INTEGRATIONS PAGE lists what a project's packages register on its `/integrations`
 *  context (iterate/integrations): one card per package, and one row per connection under it. Both
 *  are set semantics: a change appends the whole card or row again, and a null row takes one away.
 *  The install hook registers everything again (`project/worker-updated`), so a registry that was
 *  emptied, or is older than the package, heals at the next publish. */

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
export const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

/** The package's name on the Dash. */
const INTEGRATION = "google";

/** A string the registry takes: it refuses a row whose account or detail is over 200 characters. */
const fit = (text: string, max = 200): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** One registry fact. `key`, in the install hook, is made of the triggering event's path and
 *  offset, so a retry appends nothing new. A conflict on it means this event's registration landed
 *  already, perhaps with what was true then: what changed since appended its own, with no key. */
async function append(
  itx: GoogleItx,
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

/** Registers the card: whether the client is set up (its ID and its secret), whether an account is
 *  connected, and the button to the page on `slug`. */
export async function registerCard(itx: GoogleItx, slug: string, key?: string): Promise<void> {
  const ready = Boolean(await readApp(itx)) && (await hasAppSecret(itx));
  const connected = ready && (await itx.kv.list(ACCOUNTS)).keys.length > 0;
  await append(
    itx,
    "events.iterate.com/integration/configured",
    {
      integration: INTEGRATION,
      card: {
        title: "Google",
        description:
          "The project's own Google OAuth client: Google's APIs (Gmail, Calendar, Drive and the rest) as each connected account, with tokens the platform refreshes.",
        status: connected
          ? { kind: "ok" }
          : {
              kind: "attention",
              text: ready ? "Connect an account" : "Create an OAuth client and paste its secret",
            },
        actions: [{ label: connected ? "Manage" : "Connect", routingSlug: slug, path: "/" }],
      },
    },
    key,
  );
}

/** One connection's row: the account's address, the scopes Google granted, and buttons to the page
 *  and to the account's third-party access at Google, where it can take the access away. */
const rowOf = (slug: string, account: Account) => ({
  account: fit(account.account),
  status: { kind: "ok" },
  actions: [
    { label: "Manage", routingSlug: slug, path: "/" },
    { label: "Open", url: "https://myaccount.google.com/permissions" },
  ],
  details: { Scopes: fit(scopesShown(account.scopes).join(" ")) },
});

/** Sets a connection's row as the kv has it, or takes it away (null) when the kv has none. */
export async function registerRow(
  itx: GoogleItx,
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
  itx: GoogleItx,
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

/** The install hook's registration, each fact keyed by the triggering event (`at` is its path and
 *  offset), so a retry appends nothing new. First the removals that did not finish: a tombstone's
 *  kv entry goes if it is still there, then its null row, under a key of its own (the row's may be
 *  spent on this event already). Then the card, and a row per account the kv keeps. */
export async function registerAll(itx: GoogleItx, slug: string, at: string): Promise<void> {
  for (const key of (await itx.kv.list(REMOVED)).keys) {
    const connection = key.slice(REMOVED.length);
    if (!CONNECTION.test(connection)) continue;
    await itx.kv.delete(`${ACCOUNTS}${connection}`);
    await registerRemoval(itx, slug, connection, `google:registry:removed:${connection}:${at}`);
  }
  await registerCard(itx, slug, `google:registry:${at}`);
  for (const { connection } of await listAccounts(itx))
    await registerRow(itx, slug, connection, `google:registry:${connection}:${at}`);
}
