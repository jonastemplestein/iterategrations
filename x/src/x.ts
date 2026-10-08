import { SCOPES, URLS, type XItx, type Settings } from "./app.js";
import { servePage, serveCallback } from "./page.js";
import { isAppFact, registerAll, registerCard, WORKER_UPDATED } from "./registry.js";

export { APP_PIN, APP_SECRET, SCOPES, URLS, placeholder, secretOf } from "./app.js";
export type { Account, App, XItx, OAuthOptions } from "./app.js";

/** The worker that hosts the package, as iterate/sdk `Integration.fetch` is handed it:
 *  `using itx = host.getItx()` is the project's scope for one block, and `host.auth.require` the
 *  gate of a members-only page. */
export type IntegrationHost = {
  getItx(): XItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: XItx }): Promise<void>;
};

const unique = (list: string[]): string[] => [
  ...new Set(list.map((item) => item.trim()).filter(Boolean)),
];

/** A project's own X app, as an integration its worker hosts:
 *  `const integrations: Integration[] = [x()];`
 *
 *  On its routing slug it answers, for members only, the Connect X page at `/` and X's return at
 *  `/oauth2/callback`; any other path is a 404. Its install hook (`project/worker-updated`) lists it
 *  on the Dash's Integrations page: the card, and a row per connected account. The client's secret
 *  set or deleted on the Dash registers the card again.
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
      return new URL(request.url).pathname === "/oauth2/callback"
        ? await serveCallback(request, itx, settings)
        : await servePage(request, itx, settings);
    },
    async processEvent({ event, itx }) {
      const at = `${event.path}@${event.offset}`;
      if (event.type === WORKER_UPDATED) await registerAll(itx, settings.slug, at);
      else if (isAppFact(event)) await registerCard(itx, settings.slug, `x:registry:${at}`);
    },
  };
}
