import { LANDING, SCOPES, URLS, type XItx, type Settings } from "./app.js";
import { serveLanding, servePage } from "./page.js";
import {
  goneConnectionOf,
  isAppFact,
  registerAll,
  registerCard,
  registerGone,
  WORKER_UPDATED,
} from "./registry.js";

export { APP_PIN, APP_SECRET, SCOPES, URLS, placeholder, secretOf } from "./app.js";
export type { Account, App, XItx, OAuthOptions } from "./app.js";

/** The worker that hosts the package, as iterate/sdk `Integration.fetch` is handed it:
 *  `using itx = host.getItx()` is the mind's scope for one block, and `host.auth.require` the
 *  gate of a members-only page. */
export type IntegrationHost = {
  getItx(): XItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the mind, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a mind's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: XItx }): Promise<void>;
};

const unique = (list: string[]): string[] => [
  ...new Set(list.map((item) => item.trim()).filter(Boolean)),
];

/** A mind's own X app, as an integration its worker hosts:
 *  `const integrations: Integration[] = [x()];`
 *
 *  On its routing slug it answers, for members only, the Connect X page at `/` and the landing
 *  iterate's callback sends the person to once it stored an account's tokens, `/connected`; any
 *  other path is a 404. X comes back to iterate's own callback, the redirect URI the page shows. Its install hook (`mind/worker-updated`) lists it
 *  on the Dash's Integrations page: the card, and a row per connected account. The client's secret
 *  set or deleted on the Dash registers the card again, and an account's secret deleted anywhere
 *  takes its row away.
 *
 *  - `slug`: the routing slug to answer on. Default `x`.
 *  - `scopes`: more scopes to ask X for, beside `tweet.read users.read offline.access`, which name
 *    the account and bring its refresh token (`tweet.write`).
 *  - `urls`: more origins the tokens may be sent to, beside api.x.com. */
export function x(
  options: { slug?: string; scopes?: string[]; urls?: string[] } = {},
): Integration {
  const settings: Settings = {
    slug: options.slug ?? "x",
    scopes: unique([...SCOPES, ...(options.scopes ?? [])]),
    urls: unique([...URLS, ...(options.urls ?? [])]),
  };
  return {
    routingSlug: settings.slug,
    async fetch(request, host) {
      const denied = host.auth.require(request);
      if (denied) return denied;
      using itx = host.getItx();
      return new URL(request.url).pathname === LANDING
        ? await serveLanding(request, itx, settings)
        : await servePage(request, itx, settings);
    },
    async processEvent({ event, itx }) {
      const at = `${event.path}@${event.offset}`;
      const gone = goneConnectionOf(event);
      if (event.type === WORKER_UPDATED) await registerAll(itx, settings.slug, at);
      else if (isAppFact(event)) await registerCard(itx, settings.slug, `x:registry:${at}`);
      else if (gone) await registerGone(itx, settings.slug, gone, at);
    },
  };
}
