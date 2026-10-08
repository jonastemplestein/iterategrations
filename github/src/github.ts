import type { GithubItx } from "./app.js";
import { servePage, serveCallback } from "./page.js";
import { registerAll, WORKER_UPDATED } from "./registry.js";
import { receiveDelivery } from "./webhook.js";

export { APP_SECRET, PIN, placeholder, secretOf, streamOf } from "./app.js";
export type { App, GithubItx, Installation, InstallationRefresh } from "./app.js";

/** The worker that hosts the package, as iterate/sdk `Integration.fetch` is handed it:
 *  `using itx = host.getItx()` is the project's scope for one block, and `host.auth.require` the
 *  gate of a members-only page. */
export type IntegrationHost = {
  getItx(): GithubItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: GithubItx }): Promise<void>;
};

/** A project's own GitHub App, as an integration its worker hosts:
 *  `const integrations: Integration[] = [github()];`
 *
 *  On its routing slug it answers, for members only, the Connect GitHub page at `/_/` and the App's
 *  setup URL at `/callback`, and, for GitHub, the App's webhook at `/webhook` (checked with the
 *  App's webhook secret). Its install hook (`project/worker-updated`) lists it on the Dash's
 *  Integrations page: the card, and a row per installation.
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
      const page = pathname === "/_" || pathname.startsWith("/_/");
      if (!page && pathname !== "/callback") return new Response("Not found\n", { status: 404 });
      const denied = host.auth.require(request);
      if (denied) return denied;
      using itx = host.getItx();
      return page
        ? await servePage(request, itx, routingSlug)
        : await serveCallback(request, itx, routingSlug);
    },
    async processEvent({ event, itx }) {
      if (event.type === WORKER_UPDATED)
        await registerAll(itx, routingSlug, `${event.path}@${event.offset}`);
    },
  };
}
