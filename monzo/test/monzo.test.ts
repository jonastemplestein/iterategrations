// Runs against dist, the package as shipped. `fakeProject` is a project: secrets, and streams that
// keep what is appended to them and refuse a key used twice for another event (as the platform
// does; the same event again is a no-op). `host` is the worker hosting the package: a scope per
// `getItx`, counted.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { monzo } from "../dist/monzo.js";

// each account has its own secret, at /secrets/monzo-webhook-<account>
const SECRETS: Record<string, string> = {
  "/secrets/monzo-webhook-joint-account": "joint-secret",
  "/secrets/monzo-webhook-jonas-personal": "personal-secret",
};
const CONFIGURED = "events.iterate.com/integration/configured";

function fakeProject(secrets: Record<string, string> = SECRETS) {
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
    auth: { require: () => new Response("Sign in\n", { status: 401 }) },
  };
  const serve = (request: Request) => integration.fetch!(request, host);
  /** The platform's `project/worker-updated` on `/`, at `offset`: the install hook. */
  const publish = (offset: number) =>
    integration.processEvent!({
      event: { type: "events.iterate.com/project/worker-updated", path: "/", offset },
      itx,
    });
  const registry = () => appended.filter((a) => a.path === "/integrations").map((a) => a.event);
  return { integration, appended, scopes, serve, publish, registry, secrets };
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
  const project = fakeProject();
  assert.equal(project.integration.routingSlug, "monzo");
  const res = await project.serve(
    post("/joint-account/joint-secret", { type: "transaction.created", data: transaction }),
  );
  assert.equal(res.status, 200);
  await project.serve(post("/nope/nope", {}));
  assert.deepEqual(project.scopes, { opened: 2, disposed: 2 });
});

test("a transaction.created for an account becomes one event on that account's stream, the transaction untouched", async () => {
  const project = fakeProject();
  const res = await project.serve(
    post("/joint-account/joint-secret", { type: "transaction.created", data: transaction }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(project.appended, [
    {
      path: "/monzo/joint-account",
      event: {
        type: "monzo/transaction-created",
        idempotencyKey: "monzo:tx_0001",
        payload: { transactionId: "tx_0001", transaction },
      },
    },
  ]);
  await project.serve(
    post("/jonas-personal/personal-secret", {
      type: "transaction.created",
      data: { ...transaction, id: "tx_0002" },
    }),
  );
  assert.deepEqual(
    project.appended.map((a) => a.path),
    ["/monzo/joint-account", "/monzo/jonas-personal"],
  );
});

test("an account's secret opens only that account: the other's, a wrong one, an unknown or malformed account, or nothing is a 404 that stores nothing", async () => {
  const project = fakeProject();
  for (const path of [
    "/joint-account/personal-secret",
    "/jonas-personal/joint-secret",
    "/joint-account/joint-secretx",
    "/elsewhere/joint-secret",
    "/joint-account",
    "/joint-account/",
    "/",
    "",
    "/../joint-secret",
    "/Joint-Account/joint-secret",
  ]) {
    const res = await project.serve(post(path, { type: "transaction.created", data: transaction }));
    assert.equal(res.status, 404, path);
  }
  assert.deepEqual(project.appended, []);
});

test("a trailing path after the secret is fine; other event types are answered 200 and ignored; garbage is not stored", async () => {
  const project = fakeProject();
  const url = "/joint-account/joint-secret";
  const trailing = await project.serve(
    post(`${url}/anything`, { type: "transaction.created", data: transaction }),
  );
  assert.equal(trailing.status, 200);
  assert.equal(project.appended.length, 1);
  const other = await project.serve(post(url, { type: "balance.changed", data: {} }));
  assert.deepEqual(await other.json(), { ok: true, ignored: "balance.changed" });
  assert.equal((await project.serve(post(url, "not json"))).status, 200);
  assert.equal(
    (await project.serve(post(url, { type: "transaction.created", data: {} }))).status,
    400,
  );
  assert.equal(project.appended.length, 1);
});

test("only POST is accepted", async () => {
  const project = fakeProject();
  const res = await project.serve(
    new Request("https://monzo--iterate.example/joint-account/joint-secret"),
  );
  assert.equal(res.status, 405);
});

// --------------------------------------------- the Dash's Integrations page

const card = (status: object) => ({
  title: "Monzo",
  description:
    "Every Monzo transaction as a monzo/transaction-created event, on a stream per account (/monzo/<name>), from a webhook per account.",
  status,
  actions: [
    { label: "Recipe", url: "https://github.com/jonastemplestein/iterategrations/tree/main/monzo" },
  ],
});

test("the install hook registers the card, keyed by the event's path and offset: attention until the sign-in exists, ok after", async () => {
  const project = fakeProject({ ...SECRETS });
  for (let attempt = 0; attempt < 2; attempt++) await project.publish(5);
  assert.deepEqual(project.registry(), [
    {
      type: CONFIGURED,
      idempotencyKey: "monzo:registry:/@5",
      payload: {
        integration: "monzo",
        card: card({ kind: "attention", text: "Set up by your coding agent: see the recipe" }),
      },
    },
  ]);
  project.secrets["/secrets/monzo"] = "the sign-in";
  await project.publish(5); // the same event again, now signed in: its key is spent, and that is fine
  assert.equal(project.registry().length, 1);
  await project.publish(9);
  assert.deepEqual(project.registry()[1], {
    type: CONFIGURED,
    idempotencyKey: "monzo:registry:/@9",
    payload: { integration: "monzo", card: card({ kind: "ok" }) },
  });
});

test("the hook ignores every other event", async () => {
  const project = fakeProject();
  for (const type of ["monzo/transaction-created", "events.iterate.com/secret/set"])
    await project.integration.processEvent!({
      event: { type, path: "/monzo/joint-account", offset: 3 },
      itx: {} as any,
    });
  assert.deepEqual(project.appended, []);
});
