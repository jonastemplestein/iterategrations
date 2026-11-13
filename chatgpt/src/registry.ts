import { isConnected, readAccount, SECRET, type ChatgptItx } from "./auth.js";

/** THE DASH'S INTEGRATIONS PAGE lists what a mind's packages register on its `/integrations`
 *  context (iterate/integrations): the package's card, and a row per connection. Both are set
 *  semantics: a change appends the whole card or row again, and a null row takes one away. A
 *  mind has one ChatGPT connection (`/secrets/chatgpt`), so the row is set or taken away
 *  whole each time, and a registry that was emptied, or is older than the package, heals at the
 *  next publish. */

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
export const WORKER_UPDATED = "events.iterate.com/mind/worker-updated";

/** Whether an event is the connection's secret set or deleted, on the secret's own context
 *  (`event.path`): a sign-in or a deletion that did not pass through the page. */
export const isSecretFact = (event: { type: string; path: string; payload?: unknown }): boolean =>
  (event.type === "events.iterate.com/secret/set" ||
    event.type === "events.iterate.com/secret/deleted") &&
  event.path === SECRET;

/** The package's name on the Dash, and its one connection's. */
const INTEGRATION = "chatgpt";
const CONNECTION = "account";

/** One registry fact. `key`, in the install hook, is made of the triggering event's path and
 *  offset, so a retry appends nothing new. A conflict on it means this event's registration landed
 *  already, perhaps with what was true then: what changed since appended its own, with no key. */
async function append(
  itx: ChatgptItx,
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

/** Registers the card and the connection's row as they are now: the row (the account and its
 *  plan) while ChatGPT is connected, a null row while it is not. The buttons lead to `slug`'s page:
 *  the card's Connect while nothing is connected (no status, so the Dash draws it as the thing to
 *  do), and the row's Manage once it is.
 *  `at`, in the install hook, is the triggering event's path and offset. */
export async function register(itx: ChatgptItx, slug: string, at?: string): Promise<void> {
  const connected = await isConnected(itx);
  const account = connected ? await readAccount(itx) : null;
  const manage = { label: "Manage", routingSlug: slug, path: "/" };
  await append(
    itx,
    "events.iterate.com/integration/configured",
    {
      integration: INTEGRATION,
      card: {
        title: "ChatGPT",
        description:
          "Bring your own ChatGPT: Responses API requests paid by a ChatGPT Plus or Pro plan, not an API key.",
        icon: "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=64",
        ...(connected && { status: { kind: "ok", text: "Connected" } }),
        actions: connected ? [] : [{ label: "Connect", routingSlug: slug, path: "/" }],
      },
    },
    at && `chatgpt:registry:${at}`,
  );
  await append(
    itx,
    "events.iterate.com/integration/connection-configured",
    {
      integration: INTEGRATION,
      connection: CONNECTION,
      row: connected
        ? {
            account: (account?.email ?? "ChatGPT account").slice(0, 200),
            status: { kind: "ok" },
            actions: [manage],
            ...(account?.plan ? { details: { Plan: account.plan.slice(0, 200) } } : {}),
          }
        : null,
    },
    at && `chatgpt:registry:${CONNECTION}:${at}`,
  );
}
