import {
  APP_SECRET,
  CONNECTION,
  INSTALLATIONS,
  listInstallations,
  readApp,
  REMOVED,
  type GithubItx,
  type Installation,
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

/** Whether an event is the App's secret set or deleted, on `/`. A person saves the App on the Dash,
 *  never through this package, so this fact is the moment its card changes. The copy on the
 *  secret's own path lands before the catalog has it: the hook passes it over. */
export const isAppFact = (event: { type: string; path: string; payload?: unknown }): boolean =>
  event.path === "/" &&
  SECRET_FACTS.has(event.type) &&
  (event.payload as { path?: unknown } | null | undefined)?.path === APP_SECRET;

/** The package's name on the Dash. */
const INTEGRATION = "github";

/** One registry fact. `key`, in the install hook, is made of the triggering event's path and
 *  offset, so a retry appends nothing new. A conflict on it means this event's registration landed
 *  already, perhaps with what was true then: what changed since appended its own, with no key. */
async function append(
  itx: GithubItx,
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

/** Registers the card: whether the App is saved (its ID and slug public beside its secrets), and
 *  the button to the page on `slug`. */
export async function registerCard(itx: GithubItx, slug: string, key?: string): Promise<void> {
  const ready = Boolean(await readApp(itx));
  await append(
    itx,
    "events.iterate.com/integration/configured",
    {
      integration: INTEGRATION,
      card: {
        title: "GitHub",
        description:
          "The project's own GitHub App: each installation's webhook deliveries as events, and GitHub's API as the installation, with tokens the platform mints.",
        status: ready
          ? { kind: "ok" }
          : { kind: "attention", text: "Create a GitHub App and paste its secrets" },
        actions: [{ label: ready ? "Manage" : "Connect", routingSlug: slug, path: "/" }],
      },
    },
    key,
  );
}

/** One connection's row: an installation (its account, a link to it at GitHub), or a request an
 *  owner has yet to approve. */
const rowOf = (slug: string, connection: string, installation: Installation) => {
  const manage = { label: "Manage", routingSlug: slug, path: "/" };
  if (installation.requested)
    return {
      account: installation.account,
      status: { kind: "attention", text: "Awaiting an owner's approval" },
      actions: [manage],
      details: { Requested: installation.at.slice(0, 10) },
    };
  const login = /^[A-Za-z0-9-]{1,39}$/.test(installation.account) ? installation.account : null;
  return {
    account: installation.account,
    status: { kind: "ok" },
    actions: login ? [manage, { label: "Open", url: `https://github.com/${login}` }] : [manage],
    details: { Installation: connection },
  };
};

/** Sets a connection's row as the kv has it, or takes it away (null) when the kv has none. */
export async function registerRow(
  itx: GithubItx,
  slug: string,
  connection: string,
  key?: string,
): Promise<void> {
  const value = await itx.kv.get(`${INSTALLATIONS}${connection}`);
  await append(
    itx,
    "events.iterate.com/integration/connection-configured",
    {
      integration: INTEGRATION,
      connection,
      row: value ? rowOf(slug, connection, JSON.parse(value) as Installation) : null,
    },
    key,
  );
}

/** Takes a removed connection's row away (`forget` left a tombstone), then the tombstone: it
 *  stands until the null row has landed, so a failure here leaves the removal to finish. */
export async function registerRemoval(
  itx: GithubItx,
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
 *  spent on this event already). Then the card, and a row per installation the kv keeps. */
export async function registerAll(itx: GithubItx, slug: string, at: string): Promise<void> {
  for (const key of (await itx.kv.list(REMOVED)).keys) {
    const connection = key.slice(REMOVED.length);
    if (!CONNECTION.test(connection)) continue;
    await itx.kv.delete(`${INSTALLATIONS}${connection}`);
    await registerRemoval(itx, slug, connection, `github:registry:removed:${connection}:${at}`);
  }
  await registerCard(itx, slug, `github:registry:${at}`);
  for (const { connection } of await listInstallations(itx))
    await registerRow(itx, slug, connection, `github:registry:${connection}:${at}`);
}
