import type { ChatgptItx } from "./auth.js";
import { servePage } from "./page.js";
import { register, WORKER_UPDATED } from "./registry.js";

export {
  ACCOUNT_KEY,
  EXCHANGE_SOURCE,
  PIN,
  RESOURCE,
  SECRET,
  accountOf,
  claimsOf,
  isConnected,
  readAccount,
} from "./auth.js";
export type { Account, ChatgptItx } from "./auth.js";
export {
  chatgptBody,
  chatgptHeaders,
  chatgptModels,
  chatgptRequest,
  chatgptResponses,
  chatgptText,
  serverEvents,
} from "./request.js";

/** The worker that hosts the package, as `fetch` is handed it (iterate/sdk `IntegrationHost`):
 *  `using itx = host.getItx()` is the project's scope for one block, and `host.auth.require` the
 *  gate of a members-only page. */
export type IntegrationHost = {
  getItx(): ChatgptItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: ChatgptItx }): Promise<void>;
};

/** A project's ChatGPT connection, as an integration its worker hosts:
 *  `const integrations: Integration[] = [chatgpt()];`
 *
 *  On its routing slug it answers, for members only, the Connect ChatGPT page at `/`; any other
 *  path is a 404. Its install hook (`project/worker-updated`) lists it on the Dash's Integrations
 *  page: the card, and the connected account's row.
 *
 *  - `slug`: the routing slug to answer on. Default `chatgpt`. */
export function chatgpt(options: { slug?: string } = {}): Integration {
  const routingSlug = options.slug ?? "chatgpt";
  return {
    routingSlug,
    async fetch(request, host) {
      const denied = host.auth.require(request);
      if (denied) return denied;
      using itx = host.getItx();
      return await servePage(request, itx, routingSlug);
    },
    async processEvent({ event, itx }) {
      if (event.type === WORKER_UPDATED)
        await register(itx, routingSlug, `${event.path}@${event.offset}`);
    },
  };
}
