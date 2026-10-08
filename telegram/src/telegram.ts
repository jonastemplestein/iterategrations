import { registerAll, type TelegramItx } from "./bot.js";
import { servePage } from "./page.js";
import { WORKER_UPDATED } from "./registry.js";
import { receiveUpdate, type Deliver } from "./webhook.js";

export { isAddressed } from "./webhook.js";
export {
  BOT_NAME,
  MESSAGE_LIMIT,
  WELCOME,
  PRIVATE,
  api,
  keyOf,
  placeholder,
  say,
  splitText,
  streamOf,
} from "./bot.js";
export type { Deliver } from "./webhook.js";
export type { TelegramItx } from "./bot.js";

/** The worker that hosts the package, as iterate/sdk `Integration.fetch` is handed it:
 *  `using itx = host.getItx()` is the project's scope for one block, and `host.auth.require` the
 *  gate of a members-only page. */
export type IntegrationHost = {
  getItx(): TelegramItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: TelegramItx }): Promise<void>;
};

/** A project's Telegram bot, as an integration its worker hosts:
 *  `const integrations: Integration[] = [telegram()];`
 *
 *  On its routing slug it answers Telegram's webhook at `/webhook/<bot>` (checked with a secret) and,
 *  for members only, the Connect Telegram page at `/`. Its install hook (`project/worker-updated`)
 *  lists it on the Dash's Integrations page: the card, and a row per connected bot.
 *
 *  - `slug`: the routing slug to answer on. Default `telegram`.
 *  - `deliver`: `agents` (default): each chat gets an agent of its own here, which wakes for what is
 *    meant for it. `events`: the package keeps the door (who is let in, invites, welcomes) and
 *    records `telegram/message-accepted` for each message from someone let in; the project routes
 *    it to its own agents and sends their answers (iterate-telegram's `api`, `placeholder`). */
export function telegram(options: { slug?: string; deliver?: Deliver } = {}): Integration {
  const routingSlug = options.slug ?? "telegram";
  return {
    routingSlug,
    async fetch(request, host) {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/webhook/")) {
        using itx = host.getItx();
        return await receiveUpdate(request, itx, options.deliver ?? "agents", routingSlug);
      }
      const denied = host.auth.require(request);
      if (denied) return denied;
      using itx = host.getItx();
      return await servePage(request, itx, routingSlug);
    },
    async processEvent({ event, itx }) {
      if (event.type === WORKER_UPDATED)
        await registerAll(itx, routingSlug, `${event.path}@${event.offset}`);
    },
  };
}
