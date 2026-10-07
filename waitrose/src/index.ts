import { RpcTarget } from "cloudflare:workers";
import { WaitroseApi } from "./client.js";

export * from "./client.js";
export { exchange, EXCHANGE_SOURCE } from "./exchange.js";

type WaitroseMethods = { [Method in keyof WaitroseApi]: WaitroseApi[Method] };
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- the class defines every one of these methods on its prototype (the static block below), from WaitroseApi's own
export interface Waitrose extends WaitroseMethods {}

/** THE WAITROSE API AS A CAP'N WEB RPC TARGET: every method of `WaitroseApi` (search, trolley,
 *  orders, slots, checkout) is a method of this object, so it can be called in a script, or served
 *  from a config worker (`waitrose()`, below) and dialled from anywhere
 *  (`itx.connectToCapnweb(url)`).
 *
 *  `fetch` is `itx.fetch`: the token never enters this code. The requests carry
 *  `Bearer getSecret("<secret>", { field: "accessToken" })`, which egress swaps for the real token
 *  toward the secret's pinned origin (www.waitrose.com) and re-mints by the secret's exchange
 *  (`exchange.ts`) when Waitrose answers 401. `placeOrder` spends money: it places the order in the
 *  account's current trolley, after `getCheckout` review and only for the total the caller passes. */
export class Waitrose extends RpcTarget {
  readonly #api: WaitroseApi;

  constructor(options: { fetch: (request: Request) => Promise<Response>; secret?: string }) {
    super();
    const secret = options.secret ?? "/secrets/waitrose";
    this.#api = new WaitroseApi({
      fetch: (input, init) => options.fetch(new Request(input, init)),
      authorization: `Bearer getSecret(${JSON.stringify(secret)}, { field: "accessToken" })`,
    });
  }

  static {
    // Cap'n Web serves an RpcTarget's PROTOTYPE methods only, so each of the API's is defined here
    // once. The indexing is untyped because the method names come from the class at runtime; the
    // `Waitrose` interface above is what callers see.
    for (const name of Object.getOwnPropertyNames(WaitroseApi.prototype)) {
      if (name === "constructor") continue;
      Object.defineProperty(Waitrose.prototype, name, {
        value(this: Waitrose, ...args: unknown[]) {
          return (this.#api as unknown as Record<string, (...args: unknown[]) => unknown>)[name](
            ...args,
          );
        },
        writable: true,
        configurable: true,
      });
    }
  }
}

/** The project, as this package uses it: what a config worker's `itx` already has. */
export type WaitroseItx = {
  fetch(request: Request): Promise<Response>;
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

/** The card on the Dash's Integrations page (iterate/integrations). A coding agent sets Waitrose up
 *  by the recipe, so the card links there, and it is "ok" once the account's secret exists. */
const cardOf = (account: boolean) => ({
  title: "Waitrose",
  description:
    "The Waitrose grocery API (search, trolley, orders, delivery slots, checkout) as a Cap'n Web RPC target, signed in as the person's own account.",
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

/** A project's Waitrose, as an integration its worker hosts:
 *  `const integrations: Integration[] = [waitrose({ rpcResponse: newWorkersRpcResponse })];`
 *
 *  On the `waitrose` routing slug it serves a `Waitrose` to members only, over Cap'n Web: it acts as
 *  the person's account, `placeOrder` included. `rpcResponse` is iterate/sdk's
 *  `newWorkersRpcResponse`, passed in so the package never imports iterate. The target outlives the
 *  request (a WebSocket session), so each of its requests opens a scope of its own. Its install hook
 *  (`project/worker-updated`) lists it on the Dash's Integrations page. */
export function waitrose(options: {
  rpcResponse: (request: Request, target: unknown) => Response | Promise<Response>;
}): Integration {
  return {
    routingSlug: "waitrose",
    async fetch(request, host) {
      const denied = host.auth.require(request);
      if (denied) return denied;
      return await options.rpcResponse(
        request,
        new Waitrose({
          fetch: async (outbound) => {
            using itx = host.getItx();
            return await itx.fetch(outbound);
          },
        }),
      );
    },
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
