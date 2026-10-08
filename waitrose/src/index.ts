import { servePage } from "./page.js";

export { exchange, EXCHANGE_SOURCE } from "./exchange.js";
export { graphql, waitroseFetch } from "./fetch.js";
export { OPERATIONS } from "./operations.js";
export { CheckoutOutcomeUnknownError, placeOrder } from "./place-order.js";
export type { PlacedOrder, Price } from "./place-order.js";

/** The project, as the card and the page need it: what a config worker's `itx` already has. */
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

/** The worker that hosts the package, as iterate/sdk `Integration.fetch` is handed it. */
export type IntegrationHost = {
  getItx(): WaitroseItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: WaitroseItx }): Promise<void>;
};

/** The account, as the recipe's step 1 collects it. */
const ACCOUNT = "/secrets/waitrose";

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

const SLUG = "waitrose";
const TITLE = "Waitrose";
const DESCRIPTION =
  "The Waitrose grocery API (search, trolley, orders, delivery slots, checkout), signed in as the person's own account: agents and the project's code call it with fetch and the token's placeholder.";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/waitrose";

/** The card on the Dash's Integrations page (iterate/integrations). A coding agent sets Waitrose up
 *  by the recipe, so the card links to the page and to the recipe, and it is "ok" once the
 *  account's secret exists. */
const cardOf = (account: boolean) => ({
  title: TITLE,
  description: DESCRIPTION,
  icon: "https://www.google.com/s2/favicons?domain=waitrose.com&sz=64",
  status: account
    ? { kind: "ok" }
    : { kind: "attention", text: "Set up by your coding agent: see the recipe" },
  actions: [
    { label: "Open", routingSlug: SLUG, path: "/" },
    { label: "Recipe", url: RECIPE },
  ],
});

/** Whether the account's secret exists: the card's status and the page's. */
const hasAccount = async (itx: WaitroseItx): Promise<boolean> =>
  (await itx.secrets.list()).some((secret) => secret.path === ACCOUNT);

/** A project's Waitrose on the Dash, as an integration its worker hosts:
 *  `const integrations: Integration[] = [waitrose()];`
 *
 *  On the `waitrose` routing slug it answers, for members only, its page at `/`; any other path is
 *  a 404. Its install hook (`project/worker-updated`) lists Waitrose on the Dash's Integrations
 *  page. That is all it does: agents and the project's code call Waitrose with `fetch`
 *  (`waitroseFetch`, `graphql`, `placeOrder`), as the README says. */
export function waitrose(): Integration {
  return {
    routingSlug: SLUG,
    async fetch(request, host) {
      const denied = host.auth.require(request);
      if (denied) return denied;
      if (request.method !== "GET" || new URL(request.url).pathname !== "/")
        return new Response("Not found\n", { status: 404 });
      using itx = host.getItx();
      return servePage({
        title: TITLE,
        description: DESCRIPTION,
        recipe: RECIPE,
        secret: ACCOUNT,
        saved: await hasAccount(itx),
      });
    },
    async processEvent({ event, itx }) {
      if (event.type !== WORKER_UPDATED) return;
      const account = await hasAccount(itx);
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
