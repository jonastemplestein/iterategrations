/** THE DASH'S INTEGRATIONS PAGE lists what a project's packages register on its `/integrations`
 *  context (iterate/integrations): one card per package, and one row per connection under it. Both
 *  are set semantics: a change appends the whole card or row again, and a null row takes one away.
 *  A package registers everything again in its install hook (`project/worker-updated`), so a
 *  registry that was emptied, or is older than the package, heals at the next publish. The Dash
 *  composes a button's URL from its `routingSlug` and `path`, or takes its absolute `url`. */

/** What the platform appends on `/` after it publishes a commit of the config repo: a package's
 *  install hook. */
export const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

export type Status = { kind: "ok" | "attention" | "error"; text?: string };
/** A button: a page of this project, or an absolute https URL. A card or a row has at most four. */
export type Action = { label: string } & ({ routingSlug: string; path: string } | { url: string });
/** The card: a title of at most 80 characters, a description of at most 400, and an icon: an https
 *  URL of a square image (the service's mark), at most 2,048 characters. */
export type Card = {
  title: string;
  description?: string;
  icon?: string;
  status?: Status;
  actions: Action[];
};
/** One connection's row: its account (at most 200 characters) and at most ten details. */
export type Row = {
  account: string;
  status?: Status;
  actions?: Action[];
  details?: Record<string, string>;
};

/** What registering needs of the project: an append on `/integrations`, which a sub-context has. */
export type RegistryItx = {
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** One registry fact. `key`, in the install hook, is made of the triggering event's path and
 *  offset, so a retry appends nothing new. A conflict on it means this event's registration landed
 *  already, perhaps with what was true then: what changed since appended its own, with no key. */
async function append(
  itx: RegistryItx,
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

/** Registers the card of `integration` (a routing slug's shape). */
export async function setCard(
  itx: RegistryItx,
  integration: string,
  card: Card,
  key?: string,
): Promise<void> {
  await append(itx, "events.iterate.com/integration/configured", { integration, card }, key);
}

/** Sets one connection's row, or removes it with null. `connection` is a secret name's shape. */
export async function setRow(
  itx: RegistryItx,
  integration: string,
  connection: string,
  row: Row | null,
  key?: string,
): Promise<void> {
  await append(
    itx,
    "events.iterate.com/integration/connection-configured",
    { integration, connection, row },
    key,
  );
}
