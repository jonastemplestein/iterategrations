// Runs against dist, the package as shipped. `fakeMonzo` is a mind's `itx.fetch` with Monzo behind
// it: it keeps each request as sent (the token is a placeholder, never a value) and answers what
// the test gives for its method and path.
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { monzoApi } from "../dist/monzo.js";

const PLACEHOLDER = 'Bearer getSecret("/secrets/monzo", { field: "accessToken" })';

function fakeMonzo(answers: Record<string, { status?: number; body?: unknown }>) {
  const sent: { method: string; url: URL; headers: Headers; body: string }[] = [];
  const itx = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      sent.push({
        method: request.method,
        url,
        headers: request.headers,
        body: await request.text(),
      });
      const answer = answers[`${request.method} ${url.pathname}`];
      if (!answer) return new Response('{"code":"not_found"}', { status: 404 });
      return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
        status: answer.status ?? 200,
      });
    },
  };
  return { itx, sent };
}

test("every request goes to api.monzo.com with the sign-in's placeholder, never a token", async () => {
  const { itx, sent } = fakeMonzo({
    "GET /ping/whoami": { body: { authenticated: true } },
    "GET /accounts": { body: { accounts: [{ id: "acc_1" }, { id: "acc_2" }] } },
  });
  assert.deepEqual(await monzoApi(itx, "whoami"), { authenticated: true });
  assert.deepEqual(await monzoApi(itx, "list_accounts"), {
    accounts: [{ id: "acc_1" }, { id: "acc_2" }],
  });
  for (const request of sent) {
    assert.equal(request.url.origin, "https://api.monzo.com");
    assert.equal(request.headers.get("authorization"), PLACEHOLDER);
  }
});

test("a balance comes with its amounts formatted from the minor unit", async () => {
  const { itx, sent } = fakeMonzo({
    "GET /balance": { body: { balance: 12345, currency: "GBP", spend_today: -510 } },
  });
  const balance = (await monzoApi(itx, "get_balance", { account_id: "acc_1" })) as any;
  assert.equal(sent[0]!.url.searchParams.get("account_id"), "acc_1");
  assert.equal(balance.balance, 12345);
  assert.equal(balance.balance_formatted, "£123.45");
  assert.equal(balance.spend_today_formatted, "-£5.10");
});

test("transactions are asked with the merchant expanded and answered in one small shape", async () => {
  const { itx, sent } = fakeMonzo({
    "GET /transactions": {
      body: {
        transactions: [
          {
            id: "tx_1",
            account_id: "acc_1",
            created: "2026-01-02T03:04:05Z",
            settled: "",
            amount: -510,
            currency: "GBP",
            description: "COFFEE",
            merchant: { id: "merch_1", name: "Coffee Shop" },
            category: "eating_out",
            decline_reason: "",
            is_load: false,
            notes: "left out",
          },
        ],
      },
    },
  });
  const answer = await monzoApi(itx, "list_transactions", {
    account_id: "acc_1",
    since: "2026-01-01T00:00:00Z",
    limit: 5,
  });
  const query = sent[0]!.url.searchParams;
  assert.equal(query.get("account_id"), "acc_1");
  assert.equal(query.get("limit"), "5");
  assert.equal(query.get("since"), "2026-01-01T00:00:00Z");
  assert.deepEqual(query.getAll("expand[]"), ["merchant"]);
  assert.deepEqual(answer, {
    transactions: [
      {
        id: "tx_1",
        account_id: "acc_1",
        created: "2026-01-02T03:04:05Z",
        settled: "",
        amount: -510,
        currency: "GBP",
        formatted: "-£5.10",
        description: "COFFEE",
        merchant: "Coffee Shop",
        category: "eating_out",
        decline_reason: undefined,
        is_load: false,
      },
    ],
  });
  await assert.rejects(
    monzoApi(itx, "list_transactions", { account_id: "acc_1", limit: 51 }),
    /limit is 1 to 50/,
  );
});

test("a webhook is registered with a form, only to an https address, and deleted by its id", async () => {
  const { itx, sent } = fakeMonzo({
    "POST /webhooks": { body: { webhook: { id: "webhook_1" } } },
    "DELETE /webhooks/webhook_1": { body: {} },
  });
  const url = "https://monzo.example/webhook/joint-account/s3cret";
  assert.deepEqual(await monzoApi(itx, "register_webhook", { account_id: "acc_1", url }), {
    webhook: { id: "webhook_1" },
  });
  assert.equal(sent[0]!.headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(sent[0]!.body)), {
    account_id: "acc_1",
    url,
  });
  await assert.rejects(
    monzoApi(itx, "register_webhook", { account_id: "acc_1", url: "http://monzo.example/x" }),
    /https/,
  );
  assert.deepEqual(await monzoApi(itx, "delete_webhook", { webhook_id: "webhook_1" }), {
    deleted: "webhook_1",
  });
  assert.equal(sent.at(-1)!.method, "DELETE");
});

test("a refusal throws with Monzo's status, and a 403 says the app must approve", async () => {
  const { itx } = fakeMonzo({
    "GET /accounts": { status: 403, body: { code: "forbidden.insufficient_permissions" } },
  });
  await assert.rejects(monzoApi(itx, "list_accounts"), (error: Error) => {
    assert.match(error.message, /Monzo GET \/accounts: 403/);
    assert.match(error.message, /has not approved this sign-in/);
    assert.match(error.message, /forbidden\.insufficient_permissions/);
    return true;
  });
  await assert.rejects(monzoApi(itx, "nope"), /is no tool/);
});
