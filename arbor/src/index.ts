import { servePage } from "./page.js";

export { exchange, EXCHANGE_SOURCE } from "./exchange.js";
export { arborFetch, arborGet, arborUrl, submitForm } from "./fetch.js";
export type { FormAnswer } from "./fetch.js";
export { attributesOf, fieldValues, findNodes, readForm, textOf } from "./tree.js";
export type { FormField, UiNode } from "./tree.js";

/** The project, as the card and the page need it: what a config worker's `itx` already has. The
 *  catalog answers a secret's public fields (here the school `site`), and never a secret one. */
export type ArborItx = {
  secrets: { list(): Promise<{ path: string; public?: Record<string, unknown> }[]> };
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
  getItx(): ArborItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: ArborItx }): Promise<void>;
};

/** The account, as the recipe's step 1 collects it: `username`, `password`, and the public `site`. */
const ACCOUNT = "/secrets/arbor";

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

/** What the platform appends when a secret is set or deleted: first on the secret's own path, then
 *  on `/`, where the catalog folds it. The card says which site the account is for, so the copy on
 *  `/` for the account's secret registers it again. */
const SECRET_FACTS = new Set([
  "events.iterate.com/secret/set",
  "events.iterate.com/secret/deleted",
]);

const SLUG = "arbor";
const TITLE = "Arbor";
const DESCRIPTION =
  "Arbor, the school's MIS, as a parent sees it (children, meals, messages, calendar, attendance, payments, clubs and trips): agents and the project's code call it with fetch and the token's placeholder.";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/arbor";

/** The account's secret in the catalog: whether it exists, and its school site. */
async function readAccount(itx: ArborItx): Promise<{ saved: boolean; site: string | null }> {
  const entry = (await itx.secrets.list()).find((secret) => secret.path === ACCOUNT);
  const site = entry?.public?.site;
  return { saved: Boolean(entry), site: typeof site === "string" && site ? site : null };
}

/** A site's hostname for the card, or the text as it is when it is no URL: the hook never throws
 *  on what a person typed. */
const hostOf = (site: string): string => {
  try {
    return new URL(site).hostname;
  } catch {
    return site.slice(0, 100);
  }
};

/** The card on the Dash's Integrations page (iterate/integrations). A coding agent sets Arbor up by
 *  the recipe, so the card links to the page and to the recipe, and it is "ok" once the account's
 *  secret exists with its school site. */
const cardOf = ({ saved, site }: { saved: boolean; site: string | null }) => ({
  title: TITLE,
  description: DESCRIPTION,
  icon: "https://www.google.com/s2/favicons?domain=arbor-education.com&sz=64",
  status:
    saved && site
      ? { kind: "ok", text: hostOf(site) }
      : {
          kind: "attention",
          text: saved
            ? "The account has no school site: see the recipe"
            : "Set up by your coding agent: see the recipe",
        },
  actions: [
    { label: "Open", routingSlug: SLUG, path: "/" },
    { label: "Recipe", url: RECIPE },
  ],
});

/** A project's Arbor on the Dash, as an integration its worker hosts:
 *  `const integrations: Integration[] = [arbor()];`
 *
 *  On the `arbor` routing slug it answers, for members only, its page at `/`; any other path is a
 *  404. Its install hook (`project/worker-updated`, and the account's secret set or deleted) lists
 *  Arbor on the Dash's Integrations page. That is all it does: agents and the project's code call
 *  Arbor with `fetch` (`arborFetch`, `arborGet`, `submitForm`), as the README says. */
export function arbor(): Integration {
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
        ...(await readAccount(itx)),
      });
    },
    async processEvent({ event, itx }) {
      const fact =
        event.path === "/" &&
        SECRET_FACTS.has(event.type) &&
        (event.payload as { path?: unknown } | null | undefined)?.path === ACCOUNT;
      if (event.type !== WORKER_UPDATED && !fact) return;
      const account = await readAccount(itx);
      // The platform retries an event, so this card may have landed already, perhaps with what was
      // true then (IDEMPOTENCY_CONFLICT): not an error, and the next publish registers it again.
      await itx
        .cd("/integrations")
        .append({
          type: "events.iterate.com/integration/configured",
          idempotencyKey: `arbor:registry:${event.path}@${event.offset}`,
          payload: { integration: "arbor", card: cardOf(account) },
        })
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
        });
    },
  };
}
