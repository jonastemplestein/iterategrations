import {
  ACCOUNTS,
  APP_SECRET,
  CONNECTION,
  listAccounts,
  readApp,
  REMOVED,
  type Account,
  type CloudflareItx,
} from "./app.js";

/** THE DASH'S INTEGRATIONS PAGE lists what a project's packages register on its `/integrations`
 *  context (iterate/integrations): one card per package, and one row per connection under it. Both
 *  are set semantics: a change appends the whole card or row again, and a null row takes one away.
 *  The install hook registers everything again (`project/worker-updated`), so a registry that was
 *  emptied, or is older than the package, heals at the next publish. */

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
export const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

/** What the platform appends when a secret is set or deleted: first on the secret's own path, then
 *  on `/`, where the catalog (`secrets.list()`) folds it. */
const SECRET_FACTS = new Set([
  "events.iterate.com/secret/set",
  "events.iterate.com/secret/deleted",
]);

/** Whether an event is the client's secret set or deleted, on `/`. A person saves the client on the
 *  Dash, never through this package, so this fact is the moment its card changes. The copy on the
 *  secret's own path lands before the catalog has it: the hook passes it over. */
export const isAppFact = (event: { type: string; path: string; payload?: unknown }): boolean =>
  event.path === "/" &&
  SECRET_FACTS.has(event.type) &&
  (event.payload as { path?: unknown } | null | undefined)?.path === APP_SECRET;

/** The package's name on the Dash. */
const INTEGRATION = "cloudflare";

/** A string the registry takes: it refuses a row whose account or detail is over 200 characters. */
const fit = (text: string, max = 200): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** One registry fact. `key`, in the install hook, is made of the triggering event's path and
 *  offset, so a retry appends nothing new. A conflict on it means this event's registration landed
 *  already, perhaps with what was true then: what changed since appended its own, with no key. */
async function append(
  itx: CloudflareItx,
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

/** Registers the card: whether the client is saved (its ID public beside its secret), whether a
 *  person is connected, and the button to the page on `slug`. */
export async function registerCard(itx: CloudflareItx, slug: string, key?: string): Promise<void> {
  const ready = Boolean(await readApp(itx));
  const connected = ready && (await itx.kv.list(ACCOUNTS)).keys.length > 0;
  await append(
    itx,
    "events.iterate.com/integration/configured",
    {
      integration: INTEGRATION,
      card: {
        title: "Cloudflare",
        description:
          "The project's own Cloudflare OAuth client: Cloudflare's API as each connected person, on the account they picked at consent (its Workers, D1, KV, R2 and the rest), with tokens the platform refreshes.",
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

/** The accounts a connection reaches, as a row's detail: each by name and id. */
export const accountsShown = (account: Account): string =>
  account.accounts.length
    ? account.accounts.map(({ name, id }) => `${name} (${id})`).join(", ")
    : "none listed";

/** One connection's row: the person's address, the account their token reaches, the scopes
 *  Cloudflare granted, and buttons to the page and to the person's profile at Cloudflare, where
 *  the grant can be revoked. */
const rowOf = (slug: string, account: Account) => ({
  account: fit(account.account),
  status: { kind: "ok" },
  actions: [
    { label: "Manage", routingSlug: slug, path: "/" },
    { label: "Open", url: "https://dash.cloudflare.com/profile" },
  ],
  details: { Account: fit(accountsShown(account)), Scopes: fit(account.scopes.join(" ")) },
});

/** Sets a connection's row as the kv has it, or takes it away (null) when the kv has none. */
export async function registerRow(
  itx: CloudflareItx,
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
  itx: CloudflareItx,
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
 *  spent on this event already). Then the card, and a row per connection the kv keeps. */
export async function registerAll(itx: CloudflareItx, slug: string, at: string): Promise<void> {
  for (const key of (await itx.kv.list(REMOVED)).keys) {
    const connection = key.slice(REMOVED.length);
    if (!CONNECTION.test(connection)) continue;
    await itx.kv.delete(`${ACCOUNTS}${connection}`);
    await registerRemoval(itx, slug, connection, `cloudflare:registry:removed:${connection}:${at}`);
  }
  await registerCard(itx, slug, `cloudflare:registry:${at}`);
  for (const { connection } of await listAccounts(itx))
    await registerRow(itx, slug, connection, `cloudflare:registry:${connection}:${at}`);
}
