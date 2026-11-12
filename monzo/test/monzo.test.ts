// Runs against dist, the package as shipped. `fakeMind` is a mind: secrets, and streams that
// keep what is appended to them and refuse a key used twice for another event (as the platform
// does; the same event again is a no-op). `host` is the worker hosting the package: a scope per
// `getItx`, counted, and a member gate that refuses unless `member` is set.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { monzo } from "../dist/monzo.js";

// each account has its own secret, at /secrets/monzo-webhook-<account>
const SECRETS: Record<string, string> = {
  "/secrets/monzo-webhook-joint-account": "joint-secret",
  "/secrets/monzo-webhook-jonas-personal": "personal-secret",
};
const CONFIGURED = "events.iterate.com/integration/configured";
const ORIGIN = "https://monzo--iterate.example";
const RECIPE = "https://github.com/jonastemplestein/iterategrations/tree/main/monzo";

function fakeMind(secrets: Record<string, string> = SECRETS, options: { member?: boolean } = {}) {
  const appended: { path: string; event: any }[] = [];
  const scopes = { opened: 0, disposed: 0 };
  const itx: any = {
    secrets: {
      list: async () => Object.keys(secrets).map((path) => ({ path })),
      verifyEquals: async (path: string, { value }: { value: string }) => secrets[path] === value,
    },
    cd: (path: string) => ({
      append: async (event: any) => {
        const earlier = appended.find(
          (a) =>
            a.path === path &&
            event.idempotencyKey !== undefined &&
            a.event.idempotencyKey === event.idempotencyKey,
        );
        if (earlier && JSON.stringify(earlier.event) === JSON.stringify(event)) return;
        if (earlier) throw Object.assign(new Error("conflict"), { code: "IDEMPOTENCY_CONFLICT" });
        appended.push({ path, event });
      },
    }),
  };
  const integration = monzo();
  const host = {
    getItx: () => {
      scopes.opened++;
      return { ...itx, [Symbol.dispose]: () => void scopes.disposed++ };
    },
    auth: {
      require: () => (options.member ? null : new Response("Sign in\n", { status: 401 })),
    },
  };
  const serve = (request: Request) => integration.fetch!(request, host);
  /** A GET of the package's `path`, as the edge hands it on: `basePath` is what a paths ingress
   *  strips, under the platform's origin. */
  const page = (path: string, basePath?: string) =>
    serve(
      new Request(`${basePath ? "https://os.iterate.example" : ORIGIN}${path}`, {
        headers: basePath ? { "x-iterate-base-path": basePath } : {},
      }),
    );
  /** The platform's `mind/worker-updated` on `/`, at `offset`: the install hook. */
  const publish = (offset: number) =>
    integration.processEvent!({
      event: { type: "events.iterate.com/mind/worker-updated", path: "/", offset },
      itx,
    });
  const registry = () => appended.filter((a) => a.path === "/integrations").map((a) => a.event);
  return { integration, appended, scopes, serve, page, publish, registry, secrets };
}

const transaction = {
  id: "tx_0001",
  account_id: "acc_1",
  amount: -510,
  currency: "GBP",
  description: "Flat white",
  merchant: { name: "Coffee" },
};
const post = (path: string, body: unknown) =>
  new Request(`https://monzo--iterate.example${path}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("it answers the monzo routing slug; a webhook is public, so no member is asked for, and each request opens one scope and releases it", async () => {
  const mind = fakeMind();
  assert.equal(mind.integration.routingSlug, "monzo");
  const res = await mind.serve(
    post("/webhook/joint-account/joint-secret", { type: "transaction.created", data: transaction }),
  );
  assert.equal(res.status, 200);
  await mind.serve(post("/webhook/nope/nope", {}));
  assert.deepEqual(mind.scopes, { opened: 2, disposed: 2 });
});

test("a transaction.created for an account becomes one event on that account's stream, the transaction untouched", async () => {
  const mind = fakeMind();
  const res = await mind.serve(
    post("/webhook/joint-account/joint-secret", { type: "transaction.created", data: transaction }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(mind.appended, [
    {
      path: "/monzo/joint-account",
      event: {
        type: "monzo/transaction-created",
        idempotencyKey: "monzo:tx_0001",
        payload: { transactionId: "tx_0001", transaction },
      },
    },
  ]);
  await mind.serve(
    post("/webhook/jonas-personal/personal-secret", {
      type: "transaction.created",
      data: { ...transaction, id: "tx_0002" },
    }),
  );
  assert.deepEqual(
    mind.appended.map((a) => a.path),
    ["/monzo/joint-account", "/monzo/jonas-personal"],
  );
});

test("an account's secret opens only that account: the other's, a wrong one, an unknown or malformed account, or nothing is a 404 that stores nothing", async () => {
  const mind = fakeMind(SECRETS, { member: true });
  for (const path of [
    "/webhook/joint-account/personal-secret",
    "/webhook/jonas-personal/joint-secret",
    "/webhook/joint-account/joint-secretx",
    "/webhook/elsewhere/joint-secret",
    "/joint-account/joint-secret",
    "/webhook/joint-account",
    "/webhook/joint-account/",
    "/",
    "",
    "/../joint-secret",
    "/Joint-Account/joint-secret",
  ]) {
    const res = await mind.serve(post(path, { type: "transaction.created", data: transaction }));
    assert.equal(res.status, 404, path);
  }
  assert.deepEqual(mind.appended, []);
});

test("a trailing path after the secret is fine; other event types are answered 200 and ignored; garbage is not stored", async () => {
  const mind = fakeMind();
  const url = "/webhook/joint-account/joint-secret";
  const trailing = await mind.serve(
    post(`${url}/anything`, { type: "transaction.created", data: transaction }),
  );
  assert.equal(trailing.status, 200);
  assert.equal(mind.appended.length, 1);
  const other = await mind.serve(post(url, { type: "balance.changed", data: {} }));
  assert.deepEqual(await other.json(), { ok: true, ignored: "balance.changed" });
  assert.equal((await mind.serve(post(url, "not json"))).status, 200);
  assert.equal(
    (await mind.serve(post(url, { type: "transaction.created", data: {} }))).status,
    400,
  );
  assert.equal(mind.appended.length, 1);
});

test("only POST is accepted", async () => {
  const mind = fakeMind();
  const res = await mind.serve(
    new Request("https://monzo--iterate.example/webhook/joint-account/joint-secret"),
  );
  assert.equal(res.status, 405);
});

// --------------------------------------------- the Dash's Integrations page

const card = (status: object) => ({
  title: "Monzo",
  description:
    "Every Monzo transaction as a monzo/transaction-created event, on a stream per account (/monzo/<name>), from a webhook per account.",
  icon: "https://www.google.com/s2/favicons?domain=monzo.com&sz=64",
  status,
  actions: [
    { label: "Open", routingSlug: "monzo", path: "/" },
    { label: "Recipe", url: RECIPE },
  ],
});

test("the install hook registers the card, keyed by the event's path and offset: attention until the sign-in exists, ok after", async () => {
  const mind = fakeMind({ ...SECRETS });
  for (let attempt = 0; attempt < 2; attempt++) await mind.publish(5);
  assert.deepEqual(mind.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "monzo:registry:/@5",
      payload: {
        integration: "monzo",
        card: card({ kind: "attention", text: "Set up by your coding agent: see the recipe" }),
      },
    },
  ]);
  mind.secrets["/secrets/monzo"] = "the sign-in";
  await mind.publish(5); // the same event again, now signed in: its key is spent, and that is fine
  assert.equal(mind.registry().length, 1);
  await mind.publish(9);
  assert.deepEqual(mind.registry()[1], {
    type: CONFIGURED,
    idempotencyKey: "monzo:registry:/@9",
    payload: { integration: "monzo", card: card({ kind: "ok" }) },
  });
});

test("the hook ignores every other event", async () => {
  const mind = fakeMind();
  for (const type of ["monzo/transaction-created", "events.iterate.com/secret/set"])
    await mind.integration.processEvent!({
      event: { type, path: "/monzo/joint-account", offset: 3 },
      itx: {} as any,
    });
  assert.deepEqual(mind.appended, []);
});

// ------------------------------------------------------------------- the page

test("the page is for members: a non-member gets what auth.require answers, and nothing is read", async () => {
  const mind = fakeMind();
  for (const path of ["/", "/nope"]) {
    const res = await mind.page(path);
    assert.equal(res.status, 401, path);
    assert.equal(await res.text(), "Sign in\n");
  }
  assert.deepEqual(mind.scopes, { opened: 0, disposed: 0 });
});

test("the page shows the sign-in, the accounts the webhook secrets name, and the webhook URL's shape with a Copy button, with the base path a paths ingress strips; never a secret's value", async () => {
  const mind = fakeMind({ ...SECRETS, "/secrets/monzo-webhook-Not_A_Name": "x" }, { member: true });
  let res = await mind.page("/");
  let html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(html, /<h1>Monzo<\/h1>/);
  assert.match(html, /Set up by your coding agent: see the recipe/);
  const hint = `Set up Monzo in my iterate mind. Follow the recipe at ${RECIPE}`;
  assert.ok(html.includes(`data-copy="${hint}"`), hint);
  assert.ok(html.includes(`data-copy="${ORIGIN}/webhook/&lt;account&gt;/&lt;secret&gt;"`));
  assert.ok(html.includes(`href="${RECIPE}"`));
  const accounts = [...html.matchAll(/<li><b>([^<]+)<\/b>/g)].map((match) => match[1]);
  assert.deepEqual(accounts, ["joint-account", "jonas-personal"]);
  for (const value of Object.values(SECRETS)) assert.ok(!html.includes(value), value);

  mind.secrets["/secrets/monzo"] = "a-made-up-sign-in";
  res = await mind.page("/", "/minds/iterate/monzo");
  html = await res.text();
  assert.match(html, /Signed in\. The mind has the sign-in secret <code>\/secrets\/monzo<\/code>/);
  assert.doesNotMatch(html, /coding agent/);
  assert.ok(
    html.includes(
      `data-copy="https://os.iterate.example/minds/iterate/monzo/webhook/&lt;account&gt;/&lt;secret&gt;"`,
    ),
  );
  assert.ok(!html.includes("a-made-up-sign-in"));
  const empty = await fakeMind({}, { member: true }).page("/");
  assert.match(await empty.text(), /None yet/);
});

test("the page sends a CSP with its one nonce'd script, no form, and no frame, and X-Frame-Options DENY", async () => {
  const res = await fakeMind(SECRETS, { member: true }).page("/");
  const html = await res.text();
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
  assert.equal(html.match(/<script/g)!.length, 1);
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.doesNotMatch(html, /onclick=|<form/);
});

test("a member's stray path is a 404 that reads nothing", async () => {
  const mind = fakeMind(SECRETS, { member: true });
  for (const path of ["/nope", "/webhook", "/oauth2/callback"])
    assert.equal((await mind.page(path)).status, 404, path);
  assert.equal((await mind.serve(post("/", {}))).status, 404);
  assert.deepEqual(mind.scopes, { opened: 0, disposed: 0 });
});
