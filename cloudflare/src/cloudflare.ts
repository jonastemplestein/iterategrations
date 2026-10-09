import { SCOPES, URLS, type CloudflareItx, type Settings } from "./app.js";
import { servePage, serveCallback } from "./page.js";
import { isAppFact, registerAll, registerCard, WORKER_UPDATED } from "./registry.js";

export {
  APP_PIN,
  APP_SECRET,
  DEPLOY_SCOPES,
  SCOPES,
  URLS,
  accountsOf,
  listAccounts,
  placeholder,
  readAccount,
  secretOf,
} from "./app.js";
export type { Account, App, CloudflareAccount, CloudflareItx, OAuthOptions } from "./app.js";

/** The worker that hosts the package, as iterate/sdk `Integration.fetch` is handed it:
 *  `using itx = host.getItx()` is the project's scope for one block, and `host.auth.require` the
 *  gate of a members-only page. */
export type IntegrationHost = {
  getItx(): CloudflareItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: CloudflareItx }): Promise<void>;
};

const unique = (list: string[]): string[] => [
  ...new Set(list.map((item) => item.trim()).filter(Boolean)),
];

/** A project's own Cloudflare OAuth client, as an integration its worker hosts:
 *  `const integrations: Integration[] = [cloudflare()];`
 *
 *  On its routing slug it answers, for members only, the Connect Cloudflare page at `/` and
 *  Cloudflare's return at `/oauth2/callback`; any other path is a 404. Its install hook
 *  (`project/worker-updated`) lists it on the Dash's Integrations page: the card, and a row per
 *  connected person with the account their token reaches. The client's secret set or deleted on
 *  the Dash registers the card again.
 *
 *  - `slug`: the routing slug to answer on. Default `cloudflare`.
 *  - `scopes`: more scopes to ask Cloudflare for, beside `user-details.read offline_access`, which
 *    name the person: `DEPLOY_SCOPES` for everything a deploy of iterate's platform needs.
 *  - `urls`: more origins the tokens may be sent to, beside dash.cloudflare.com and
 *    api.cloudflare.com. */
export function cloudflare(
  options: { slug?: string; scopes?: string[]; urls?: string[] } = {},
): Integration {
  const settings: Settings = {
    slug: options.slug ?? "cloudflare",
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
      else if (isAppFact(event))
        await registerCard(itx, settings.slug, `cloudflare:registry:${at}`);
    },
  };
}
