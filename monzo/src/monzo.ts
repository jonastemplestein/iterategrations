/** The project, as this package uses it: what a config worker's `itx` already has. */
export type MonzoItx = {
  secrets: {
    list(): Promise<{ path: string }[]>;
    verifyEquals(path: string, input: { value: string }): Promise<boolean>;
  };
  cd(path: string): {
    append(event: {
      type: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/** The worker that hosts the package, as `fetch` is handed it (iterate/sdk `IntegrationHost`). */
export type IntegrationHost = {
  getItx(): MonzoItx & Disposable;
  auth: { require(request: Request): Response | null };
};

/** One durable event of the project, as `processEvent` is handed it. */
export type IntegrationEvent = { type: string; path: string; offset: number; payload?: unknown };

/** What a project's worker hosts beside its own code (iterate/sdk `Integration`), declared here so
 *  the package builds and tests without iterate. */
export type Integration = {
  routingSlug?: string;
  fetch?(request: Request, host: IntegrationHost): Promise<Response>;
  processEvent?(args: { event: IntegrationEvent; itx: MonzoItx }): Promise<void>;
};

/** An account's name in a URL, a secret path and a stream path: `joint-account`, `jonas-personal`.
 *  It is also the account's connection on the Dash's Integrations page. */
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The sign-in zero-trust-mcp keeps for the project (the recipe's step 1). */
const SIGN_IN = "/secrets/monzo";

/** What the platform appends on `/` after it publishes a commit of the config repo: the install
 *  hook. */
const WORKER_UPDATED = "events.iterate.com/project/worker-updated";

/** The card on the Dash's Integrations page (iterate/integrations). A coding agent sets Monzo up by
 *  the recipe, so the card links there, and it is "ok" once the sign-in exists. */
const cardOf = (signedIn: boolean) => ({
  title: "Monzo",
  description:
    "Every Monzo transaction as a monzo/transaction-created event, on a stream per account (/monzo/<name>), from a webhook per account.",
  status: signedIn
    ? { kind: "ok" }
    : { kind: "attention", text: "Set up by your coding agent: see the recipe" },
  actions: [
    { label: "Recipe", url: "https://github.com/jonastemplestein/iterategrations/tree/main/monzo" },
  ],
});

/** The platform retries an event, so a card keyed by it may have landed already, perhaps with what
 *  was true then (`IDEMPOTENCY_CONFLICT`): that is not an error, and the next publish registers the
 *  card again. */
const once = (append: Promise<unknown>): Promise<unknown> =>
  append.catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== "IDEMPOTENCY_CONFLICT") throw error;
  });

/** Monzo's webhook: it POSTs `{ type: "transaction.created", data: <the transaction> }` to the URL
 *  registered for an account, and retries a delivery that does not answer 200 (up to five times).
 *  Monzo does not sign anything, so each account's URL is `/<account name>/<secret>`, the secret
 *  being `/secrets/monzo-webhook-<account name>`, checked with `itx.secrets.verifyEquals`. Each
 *  transaction becomes one `monzo/transaction-created` event on the stream `/monzo/<account name>`,
 *  the transaction as Monzo sent it in `payload.transaction`. */
async function receive(request: Request, itx: MonzoItx): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  const [, account = "", presented = ""] = new URL(request.url).pathname
    .split("/")
    .map(decodeURIComponent);
  const known =
    ACCOUNT_NAME.test(account) &&
    presented !== "" &&
    (await itx.secrets.verifyEquals(`/secrets/monzo-webhook-${account}`, { value: presented }));
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

/** A project's Monzo receiver, as an integration its worker hosts:
 *  `const integrations: Integration[] = [monzo()];`
 *
 *  On the `monzo` routing slug it answers Monzo's webhook at `/<account name>/<secret>`. Its install
 *  hook (`project/worker-updated`) lists it on the Dash's Integrations page. Each account's row is
 *  appended by the recipe's script that registers the account's webhook. */
export function monzo(): Integration {
  return {
    routingSlug: "monzo",
    async fetch(request, host) {
      using itx = host.getItx();
      return await receive(request, itx);
    },
    async processEvent({ event, itx }) {
      if (event.type !== WORKER_UPDATED) return;
      const signedIn = (await itx.secrets.list()).some((secret) => secret.path === SIGN_IN);
      await once(
        itx.cd("/integrations").append({
          type: "events.iterate.com/integration/configured",
          idempotencyKey: `monzo:registry:${event.path}@${event.offset}`,
          payload: { integration: "monzo", card: cardOf(signedIn) },
        }),
      );
    },
  };
}
