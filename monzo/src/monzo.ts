import { servePage } from "./page.js";

export { monzoApi, type MonzoApiItx } from "./api.js";

/** The mind, as this package uses it: what a config worker's `itx` already has. */
export type MonzoItx = {
  secrets: {
    list(): Promise<{ path: string }[]>;
    verifyEquals(path: string, input: { value: string }): Promise<boolean>;
  };
  /** The registry the Dash's Integrations page draws (`/integrations`), as folded: the hook reads
   *  it to take away the row of an account whose webhook secret is gone. Optional, so a mind
   *  without it still registers everything else. */
  integrations?: {
    list(): Promise<{ connections: Record<string, unknown> }>;
  };
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
  getItx(): MonzoItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the mind, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a mind's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: MonzoItx }): Promise<void>;
};

/** An account's name in a URL, a secret path and a stream path: `joint-account`, `jonas-personal`.
 *  It is also the account's connection on the Dash's Integrations page. */
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The mind's own OAuth sign-in with Monzo (the recipe's step 1). */
const SIGN_IN = "/secrets/monzo";

/** Each account's webhook secret is this and the account's name (the recipe's step 4). */
const WEBHOOK_SECRETS = "/secrets/monzo-webhook-";

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
const WORKER_UPDATED = "events.iterate.com/mind/worker-updated";

const SLUG = "monzo";
const TITLE = "Monzo";
const DESCRIPTION =
  "Every Monzo transaction as a monzo/transaction-created event, on a stream per account (/monzo/<name>), from a webhook per account.";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/monzo";

/** The card on the Dash's Integrations page (iterate/integrations). A coding agent sets Monzo up by
 *  the recipe, so the card links to the page and to the recipe, and it is "ok" once the sign-in
 *  exists. */
const cardOf = (signedIn: boolean) => ({
  title: TITLE,
  description: DESCRIPTION,
  icon: "https://www.google.com/s2/favicons?domain=monzo.com&sz=64",
  // set up: "OK"; not yet: no status, and the recipe first, the one thing to do
  ...(signedIn && { status: { kind: "ok" } }),
  actions: [
    ...(signedIn ? [] : [{ label: "Set up", url: RECIPE }]),
    { label: "Open", routingSlug: SLUG, path: "/" },
    ...(signedIn ? [{ label: "Recipe", url: RECIPE }] : []),
  ],
});

/** What the secrets list says of Monzo: whether the sign-in exists (the card's status and the
 *  page's), and the accounts whose webhook secret exists, by name. */
async function setupOf(itx: MonzoItx): Promise<{ signedIn: boolean; accounts: string[] }> {
  const paths = (await itx.secrets.list()).map((secret) => secret.path);
  const accounts = paths
    .filter((path) => path.startsWith(WEBHOOK_SECRETS))
    .map((path) => path.slice(WEBHOOK_SECRETS.length))
    .filter((name) => ACCOUNT_NAME.test(name))
    .sort();
  return { signedIn: paths.includes(SIGN_IN), accounts };
}

/** The platform retries an event, so a card keyed by it may have landed already, perhaps with what
 *  was true then (`IDEMPOTENCY_CONFLICT`): that is not an error, and the next publish registers the
 *  card again. */
const once = (append: Promise<unknown>): Promise<unknown> =>
  append.catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
  });

/** Monzo's webhook: it POSTs `{ type: "transaction.created", data: <the transaction> }` to the URL
 *  registered for an account, and retries a delivery that does not answer 200 (up to five times).
 *  Monzo does not sign anything, so each account's URL is `/webhook/<account name>/<secret>`, the secret
 *  being `/secrets/monzo-webhook-<account name>`, checked with `itx.secrets.verifyEquals`. Each
 *  transaction becomes one `monzo/transaction-created` event on the stream `/monzo/<account name>`,
 *  the transaction as Monzo sent it in `payload.transaction`. */
async function receive(request: Request, itx: MonzoItx): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  const [, place = "", account = "", presented = ""] = new URL(request.url).pathname
    .split("/")
    .map(decodeURIComponent);
  const known =
    place === "webhook" &&
    ACCOUNT_NAME.test(account) &&
    presented !== "" &&
    (await itx.secrets.verifyEquals(`${WEBHOOK_SECRETS}${account}`, { value: presented }));
  // an unknown account, or a wrong or missing secret, looks like any other path
  if (!known) return new Response("Not found\n", { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    type?: unknown;
    data?: { id?: unknown };
  } | null; // Monzo's documented shape; each field is checked below
  if (body?.type !== "transaction.created")
    return Response.json({
      ok: true,
      ignored: typeof body?.type === "string" ? body.type : body ? "no type" : "not JSON",
    });
  const transactionId = body.data?.id;
  if (typeof transactionId !== "string" || !transactionId)
    return new Response("no transaction id\n", { status: 400 });

  await itx.cd(`/monzo/${account}`).append({
    type: "monzo/transaction-created",
    // Monzo's retry of a delivery is the same event
    idempotencyKey: "monzo:" + transactionId,
    payload: { transactionId, transaction: body.data },
  });
  return Response.json({ ok: true });
}

/** A mind's Monzo receiver, as an integration its worker hosts:
 *  `const integrations: Integration[] = [monzo()];`
 *
 *  On the `monzo` routing slug it answers Monzo's webhook at `/webhook/<account name>/<secret>` and,
 *  for members only, its page at `/`; any other path is a 404. Its install hook
 *  (`mind/worker-updated`, and a Monzo secret set or deleted) lists it on the Dash's Integrations
 *  page: the card, and a row per account whose webhook secret exists. An account's row goes when
 *  its secret does. */
export function monzo(): Integration {
  return {
    routingSlug: SLUG,
    async fetch(request, host) {
      const { pathname } = new URL(request.url);
      if (pathname.startsWith("/webhook/")) {
        using itx = host.getItx();
        return await receive(request, itx);
      }
      const denied = host.auth.require(request);
      if (denied) return denied;
      if (request.method !== "GET" || pathname !== "/")
        return new Response("Not found\n", { status: 404 });
      using itx = host.getItx();
      return servePage(request, {
        title: TITLE,
        description: DESCRIPTION,
        recipe: RECIPE,
        signIn: SIGN_IN,
        webhookSecrets: WEBHOOK_SECRETS,
        ...(await setupOf(itx)),
      });
    },
    async processEvent({ event, itx }) {
      // the publish, or a Monzo secret set or deleted (the sign-in, or an account's webhook
      // secret): the fact lands on the secret's own context, `/secrets/<name>`
      const fact =
        (event.type === "events.iterate.com/secret/set" ||
          event.type === "events.iterate.com/secret/deleted") &&
        (event.path === SIGN_IN ||
          (event.path.startsWith(WEBHOOK_SECRETS) &&
            !event.path.includes("/", WEBHOOK_SECRETS.length)));
      if (event.type !== WORKER_UPDATED && !fact) return;
      const at = `${event.path}@${event.offset}`;
      const { signedIn, accounts } = await setupOf(itx);
      const registry = itx.cd("/integrations");
      await once(
        registry.append({
          type: "events.iterate.com/integration/configured",
          idempotencyKey: `monzo:registry:${at}`,
          payload: { integration: "monzo", card: cardOf(signedIn) },
        }),
      );
      // a row per account whose webhook secret exists, by its name; a row that is well needs no
      // words, and Monzo's account id is no fact a person reads
      for (const name of accounts)
        await once(
          registry.append({
            type: "events.iterate.com/integration/connection-configured",
            idempotencyKey: `monzo:registry:${name}:${at}`,
            payload: {
              integration: "monzo",
              connection: name,
              row: { account: name, status: { kind: "ok" }, actions: [] },
            },
          }),
        );
      // and a null for each row of an account whose secret is gone
      const registered = itx.integrations ? (await itx.integrations.list()).connections : {};
      for (const key of Object.keys(registered)) {
        const name = key.slice("monzo/".length);
        if (key.startsWith("monzo/") && !accounts.includes(name))
          await once(
            registry.append({
              type: "events.iterate.com/integration/connection-configured",
              idempotencyKey: `monzo:registry:${name}:${at}`,
              payload: { integration: "monzo", connection: name, row: null },
            }),
          );
      }
    },
  };
}
