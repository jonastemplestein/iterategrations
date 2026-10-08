import { SCOPES, URLS, type GoogleItx, type Settings } from "./app.js";
import { servePage, serveCallback } from "./page.js";
import { registerAll, WORKER_UPDATED } from "./registry.js";

export { APP_PIN, APP_SECRET, SCOPES, URLS, placeholder, secretOf } from "./app.js";
export type { Account, App, GoogleItx, OAuthOptions } from "./app.js";

/** The worker that hosts the package, as iterate/sdk `Integration.fetch` is handed it:
 *  `using itx = host.getItx()` is the project's scope for one block, and `host.auth.require` the
 *  gate of a members-only page. */
export type IntegrationHost = {
  getItx(): GoogleItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: GoogleItx }): Promise<void>;
};

const unique = (list: string[]): string[] => [
  ...new Set(list.map((item) => item.trim()).filter(Boolean)),
];

/** A project's own Google OAuth client, as an integration its worker hosts:
 *  `const integrations: Integration[] = [google()];`
 *
 *  On its routing slug it answers, for members only, the Connect Google page at `/` and Google's
 *  return at `/oauth2/callback`; any other path is a 404. Its install hook
 *  (`project/worker-updated`) lists it on the Dash's Integrations page: the card, and a row per
 *  connected account.
 *
 *  - `slug`: the routing slug to answer on. Default `google`.
 *  - `scopes`: more scopes to ask Google for, beside `openid email profile`, which name the account
 *    (`https://www.googleapis.com/auth/gmail.readonly`).
 *  - `urls`: more origins the tokens may be sent to, beside oauth2.googleapis.com,
 *    www.googleapis.com and gmail.googleapis.com (`https://sheets.googleapis.com`). */
export function google(
  options: { slug?: string; scopes?: string[]; urls?: string[] } = {},
): Integration {
  const settings: Settings = {
    slug: options.slug ?? "google",
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
      if (event.type === WORKER_UPDATED)
        await registerAll(itx, settings.slug, `${event.path}@${event.offset}`);
    },
  };
}
