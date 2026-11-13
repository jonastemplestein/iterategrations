import {
  APP_SECRET,
  CONNECTION,
  forget,
  INSTALLATION_ID,
  INSTALLATIONS,
  listInstallations,
  readApp,
  REMOVED,
  secretOf,
  type GithubItx,
  type Installation,
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

/** The installation whose secret was deleted, by its id: a `secret/deleted` on the secret's
 *  own context, `/secrets/own-github-<installation id>`. Remove deletes it too, and then
 *  finds no installation left; a deletion on the Dash, or anywhere else, leaves an installation
 *  with no token, and its row goes (`registerGone`). */
export const goneConnectionOf = (event: {
  type: string;
  path: string;
  payload?: unknown;
}): string | null => {
  if (event.type !== "events.iterate.com/secret/deleted") return null;
  const { path } = event;
  const id = typeof path === "string" ? path.slice(secretOf("").length) : "";
  return path === secretOf(id) && INSTALLATION_ID.test(id) ? id : null;
};

/** The installation GitHub says was uninstalled, by its id: the `installation` delivery with
 *  action `deleted`, as the webhook recorded it on the installation's stream. */
export const uninstalledOf = (event: { type: string; payload?: unknown }): string | null => {
  if (event.type !== "github/delivery-received") return null;
  const payload = event.payload as {
    installationId?: unknown;
    delivery?: { name?: unknown };
    body?: { action?: unknown };
  } | null;
  const id = payload?.installationId;
  return payload?.delivery?.name === "installation" &&
    payload.body?.action === "deleted" &&
    typeof id === "string" &&
    INSTALLATION_ID.test(id)
    ? id
    : null;
};

/** Whether an event is the App's secret set or deleted, on that secret's own context. A person saves the App on the Dash,
 *  never through this package, so this fact is the moment its card changes. */
export const isAppFact = (event: { type: string; path: string; payload?: unknown }): boolean =>
  SECRET_FACTS.has(event.type) && event.path === APP_SECRET;

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

/** Registers the card. Its status is the installations', never the setup's: once an
 *  installation is connected the card says so, whatever the catalog says of the App (an
 *  installation keeps working with an App saved before the form asked for its ID and slug). Before
 *  that it has no status, and its one button is the next step on the page at `slug`: the Dash draws
 *  it as the thing to do. A request that waits for an owner says so on its own row. */
export async function registerCard(itx: GithubItx, slug: string, key?: string): Promise<void> {
  const installed = (await listInstallations(itx)).filter((one) => !one.requested).length;
  const ready = installed > 0 || Boolean(await readApp(itx));
  await append(
    itx,
    "events.iterate.com/integration/configured",
    {
      integration: INTEGRATION,
      card: {
        title: "GitHub",
        description:
          "The mind's own GitHub App: each installation's webhook deliveries as events, and GitHub's API as the installation, with tokens the platform mints.",
        icon: "https://www.google.com/s2/favicons?domain=github.com&sz=64",
        ...(installed > 0 && {
          status: {
            kind: "ok",
            text: installed === 1 ? "Connected" : `${installed} installations`,
          },
        }),
        actions: [
          {
            label: installed > 0 ? "Install on another account" : ready ? "Install" : "Set up",
            routingSlug: slug,
            path: "/",
          },
        ],
      },
    },
    key,
  );
}

/** One connection's row: an installation (its account, a link to it at GitHub), or a request an
 *  owner has yet to approve. A row that is well needs no words: the Dash shows its dot. */
const rowOf = (slug: string, installation: Installation) => {
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
      row: value ? rowOf(slug, JSON.parse(value) as Installation) : null,
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

/** An installation whose token is gone: its secret deleted anywhere, or the App uninstalled at
 *  GitHub (`uninstalled`, which deletes the secret too). Its row goes, by the same tombstone as
 *  Remove. Nothing happens when the kv has no such installation (Remove took it away already) or,
 *  for a deleted secret, the secret is back. */
export async function registerGone(
  itx: GithubItx,
  slug: string,
  connection: string,
  at: string,
  uninstalled = false,
): Promise<void> {
  if (!(await itx.kv.get(`${INSTALLATIONS}${connection}`))) return;
  if (uninstalled) await forget(itx, connection);
  else {
    if ((await itx.secrets.list()).some((secret) => secret.path === secretOf(connection))) return;
    await itx.kv.put(`${REMOVED}${connection}`, JSON.stringify({ at: new Date().toISOString() }));
    await itx.kv.delete(`${INSTALLATIONS}${connection}`);
  }
  await registerRemoval(itx, slug, connection, `github:registry:gone:${connection}:${at}`);
  await registerCard(itx, slug, `github:registry:${at}`);
}

/** The install hook's registration, each fact keyed by the triggering event (`at` is its path and
 *  offset), so a retry appends nothing new. First the removals that did not finish: a tombstone's
 *  kv entry goes if it is still there, then its null row, under a key of its own (the row's may be
 *  spent on this event already). Then each installation whose secret the catalog no longer has: it
 *  goes the same way. Then the card, a row per installation the kv keeps, and a null for each row
 *  the registry holds of one the kv does not (`itx.integrations.list()`, where the mind has it). */
export async function registerAll(itx: GithubItx, slug: string, at: string): Promise<void> {
  for (const key of (await itx.kv.list(REMOVED)).keys) {
    const connection = key.slice(REMOVED.length);
    if (!CONNECTION.test(connection)) continue;
    await itx.kv.delete(`${INSTALLATIONS}${connection}`);
    await registerRemoval(itx, slug, connection, `github:registry:removed:${connection}:${at}`);
  }
  const held = new Set((await itx.secrets.list()).map((secret) => secret.path));
  for (const { connection } of await listInstallations(itx))
    if (INSTALLATION_ID.test(connection) && !held.has(secretOf(connection))) {
      await itx.kv.put(`${REMOVED}${connection}`, JSON.stringify({ at: new Date().toISOString() }));
      await itx.kv.delete(`${INSTALLATIONS}${connection}`);
      await registerRemoval(itx, slug, connection, `github:registry:removed:${connection}:${at}`);
    }
  await registerCard(itx, slug, `github:registry:${at}`);
  const kept = new Set<string>();
  for (const { connection } of await listInstallations(itx)) {
    kept.add(connection);
    await registerRow(itx, slug, connection, `github:registry:${connection}:${at}`);
  }
  const registered = itx.integrations ? (await itx.integrations.list()).connections : {};
  for (const key of Object.keys(registered)) {
    const connection = key.slice(`${INTEGRATION}/`.length);
    if (key.startsWith(`${INTEGRATION}/`) && !kept.has(connection))
      await append(
        itx,
        "events.iterate.com/integration/connection-configured",
        { integration: INTEGRATION, connection, row: null },
        `github:registry:${connection}:${at}`,
      );
  }
}
