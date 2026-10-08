export { exchange, EXCHANGE_SOURCE } from "./exchange.js";
export { graphql, waitroseFetch } from "./fetch.js";
export { OPERATIONS } from "./operations.js";
export { CheckoutOutcomeUnknownError, placeOrder } from "./place-order.js";
export type { PlacedOrder, Price } from "./place-order.js";

/** The project, as the card needs it: what a config worker's `itx` already has. */
export type WaitroseItx = {
  secrets: { list(): Promise<{ path: string }[]> };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. Waitrose has no host of its own, so no
 *  `routingSlug` and no `fetch`. */
export type Integration = {
  routingSlug?: string;
  processEvent?(args: { event: IntegrationEvent; itx: WaitroseItx }): Promise<void>;
};

/** The account, as the recipe's step 1 collects it. */
const ACCOUNT = "/secrets/waitrose";

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

/** The card on the Dash's Integrations page (iterate/integrations). A coding agent sets Waitrose up
 *  by the recipe, so the card links there, and it is "ok" once the account's secret exists. */
const cardOf = (account: boolean) => ({
  title: "Waitrose",
  description:
    "The Waitrose grocery API (search, trolley, orders, delivery slots, checkout), signed in as the person's own account: agents and the project's code call it with fetch and the token's placeholder.",
  status: account
    ? { kind: "ok" }
    : { kind: "attention", text: "Set up by your coding agent: see the recipe" },
  actions: [
    {
      label: "Recipe",
      url: "https://github.com/jonastemplestein/iterategrations/tree/main/waitrose",
    },
  ],
});

/** A project's Waitrose on the Dash, as an integration its worker hosts:
 *  `const integrations: Integration[] = [waitrose()];`
 *
 *  Its install hook (`project/worker-updated`) lists Waitrose on the Dash's Integrations page. That
 *  is all it does: agents and the project's code call Waitrose with `fetch` (`waitroseFetch`,
 *  `graphql`, `placeOrder`), as the README says. */
export function waitrose(): Integration {
  return {
    async processEvent({ event, itx }) {
      if (event.type !== WORKER_UPDATED) return;
      const account = (await itx.secrets.list()).some((secret) => secret.path === ACCOUNT);
      // The platform retries an event, so this card may have landed already, perhaps with what was
      // true then (IDEMPOTENCY_CONFLICT): not an error, and the next publish registers it again.
      await itx
        .cd("/integrations")
        .append({
          type: "events.iterate.com/integration/configured",
          idempotencyKey: `waitrose:registry:${event.path}@${event.offset}`,
          payload: { integration: "waitrose", card: cardOf(account) },
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
        });
    },
  };
}
