import { isConnected, readAccount, type ChatgptItx } from "./auth.js";

/** THE DASH'S INTEGRATIONS PAGE lists what a project's packages register on its `/integrations`
 *  context (iterate/integrations): the package's card, and a row per connection. Both are set
 *  semantics: a change appends the whole card or row again, and a null row takes one away. A
 *  project has one ChatGPT connection (`/secrets/chatgpt`), so the row is set or taken away
 *  whole each time, and a registry that was emptied, or is older than the package, heals at the
 *  next publish. */

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
export const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

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
 *  plan) while ChatGPT is connected, a null row while it is not. The buttons lead to `slug`'s page.
 *  `at`, in the install hook, is the triggering event's path and offset. */
export async function register(itx: ChatgptItx, slug: string, at?: string): Promise<void> {
  const connected = await isConnected(itx);
  const account = connected ? await readAccount(itx) : null;
  const manage = { label: connected ? "Manage" : "Connect", routingSlug: slug, path: "/" };
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
        status: connected ? { kind: "ok" } : { kind: "attention", text: "Connect ChatGPT" },
        actions: [manage],
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
