import type { GithubItx } from "./app.js";
import { servePage, serveCallback } from "./page.js";
import {
  goneConnectionOf,
  isAppFact,
  registerAll,
  registerCard,
  registerGone,
  uninstalledOf,
  WORKER_UPDATED,
} from "./registry.js";
import { receiveDelivery } from "./webhook.js";

export { APP_SECRET, PIN, placeholder, secretOf, streamOf } from "./app.js";
export type { App, GithubItx, Installation, InstallationRefresh } from "./app.js";

/** The worker that hosts the package, as iterate/sdk `Integration.fetch` is handed it:
 *  `using itx = host.getItx()` is the mind's scope for one block, and `host.auth.require` the
 *  gate of a members-only page. */
export type IntegrationHost = {
  getItx(): GithubItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the mind, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a mind's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: GithubItx }): Promise<void>;
};

/** A mind's own GitHub App, as an integration its worker hosts:
 *  `const integrations: Integration[] = [github()];`
 *
 *  On its routing slug it answers, for members only, the Connect GitHub page at `/` and the App's
 *  setup URL at `/oauth2/callback`, and, for GitHub, the App's webhook at `/webhook` (checked with
 *  the App's webhook secret). Its install hook (`mind/worker-updated`) lists it on the Dash's
 *  Integrations page: the card, and a row per installation. The App's secret set or deleted on the
 *  Dash registers the card again. An installation's secret deleted anywhere, or the App
 *  uninstalled at GitHub (its `installation` delivery with action `deleted`), takes its row away.
 *
 *  - `slug`: the routing slug to answer on. Default `github`. */
export function github(options: { slug?: string } = {}): Integration {
  const routingSlug = options.slug ?? "github";
  return {
    routingSlug,
    async fetch(request, host) {
      const { pathname } = new URL(request.url);
      if (pathname === "/webhook") {
        using itx = host.getItx();
        return await receiveDelivery(request, itx);
      }
      const denied = host.auth.require(request);
      if (denied) return denied;
      using itx = host.getItx();
      return pathname === "/oauth2/callback"
        ? await serveCallback(request, itx, routingSlug)
        : await servePage(request, itx, routingSlug);
    },
    async processEvent({ event, itx }) {
      const at = `${event.path}@${event.offset}`;
      const gone = goneConnectionOf(event);
      const uninstalled = uninstalledOf(event);
      if (event.type === WORKER_UPDATED) await registerAll(itx, routingSlug, at);
      else if (isAppFact(event)) await registerCard(itx, routingSlug, `github:registry:${at}`);
      else if (gone) await registerGone(itx, routingSlug, gone, at);
      else if (uninstalled) await registerGone(itx, routingSlug, uninstalled, at, true);
    },
  };
}
