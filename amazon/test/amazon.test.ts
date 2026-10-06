import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { AmazonApi, ZincError } from "../dist/client.js";
import type { PlaceOrder, ZincObject } from "../dist/client.js";
import { registerAmazonAccount } from "../dist/setup.js";
import { zincRequest } from "../dist/transport.js";

type Submitted = PlaceOrder & {
  retailer_credentials_id: string;
  payment?: unknown;
  fulfillment?: unknown;
};

const ACCOUNT = "zn_acct_research";
const ID = "12345678-1234-1234-1234-123456789abc";
const AUTHORIZATION = 'Bearer getSecret("/secrets/zinc")';
const PRODUCT_URL = "https://www.amazon.co.uk/dp/B0C2J7Z17K";
const PREFLIGHT = { orderable: true, retailer: { retailer: "amazon-uk", country: "GB" } };
const ORDER = { id: ID, status: "pending", retailer_credentials_id: ACCOUNT };
function order(): PlaceOrder {
  return {
    products: [{ url: PRODUCT_URL, quantity: 2 }],
    shipping_address: {
      first_name: "Test",
      last_name: "Buyer",
      address_line1: "1 Test Street",
      city: "London",
      postal_code: "SW1A 1AA",
      phone_number: "+447700900123",
      country: "GB",
    },
    max_price: 2000,
    idempotency_key: "logical-purchase-1",
  };
}
function fake(
  answer: (request: Request) => Response | Promise<Response> = (request) =>
    Response.json(new URL(request.url).pathname === "/retailers/check" ? PREFLIGHT : ORDER),
) {
  const seen: Request[] = [];
  const api = new AmazonApi({
    retailerCredentialsId: ACCOUNT,
    authorization: AUTHORIZATION,
    purchasePolicy: { maxPrice: 3000 },
    fetch: async (request) => {
      seen.push(request.clone());
      return answer(request);
    },
  });
  return { api, seen };
}

test("purchases are disabled by default, and invalid caps cannot enable them", async () => {
  let calls = 0;
  const api = new AmazonApi({
    retailerCredentialsId: ACCOUNT,
    authorization: AUTHORIZATION,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(api.placeOrder(order()), /disabled/);
  assert.equal(calls, 0);
  assert.equal(api.__describe().purchasesEnabled, false);
  assert.throws(
    () =>
      new AmazonApi({
        retailerCredentialsId: ACCOUNT,
        authorization: AUTHORIZATION,
        fetch: async () => Response.json({}),
        purchasePolicy: { maxPrice: NaN },
      }),
    /positive/,
  );
});

test("orders pin the account, GB address and conditions, and preflight before one POST", async () => {
  const { api, seen } = fake();
  const input = {
    ...order(),
    retailer_credentials_id: "zn_acct_other",
    payment: { mode: "card" },
    fulfillment: { items: "best_effort" },
  };
  input.products[0]!.url = "https://amazon.co.uk/a-title/dp/B0C2J7Z17K?tag=tracking";
  assert.deepEqual(await api.placeOrder(input), { outcome: "submitted", order: ORDER });
  assert.equal(seen.length, 2);
  const preflight = new globalThis.URL(seen[0]!.url);
  assert.equal(preflight.searchParams.get("country"), "GB");
  assert.equal(preflight.searchParams.get("url"), PRODUCT_URL);
  assert.equal(seen[1]!.url, "https://api.zinc.com/orders");
  const body = (await seen[1]!.json()) as Submitted;
  assert.equal(body.retailer_credentials_id, ACCOUNT);
  assert.equal(body.idempotency_key, "logical-purchase-1");
  assert.deepEqual(body.products, [{ url: PRODUCT_URL, quantity: 2, condition_in: ["New"] }]);
  assert.equal(body.shipping_address.country, "GB");
  assert.equal(body.payment, undefined);
  assert.equal(body.fulfillment, undefined); // omitted is strict in Zinc
  assert.ok(seen.every((r) => r.headers.get("authorization") === AUTHORIZATION));
  assert.ok(seen.every((r) => r.redirect === "error"));
});

test("price, key, destination, product URLs and quantities fail before network use", async () => {
  const { api, seen } = fake();
  const invalid: PlaceOrder[] = [
    { ...order(), max_price: 3001 },
    { ...order(), max_price: NaN },
    { ...order(), max_price: 0 },
    { ...order(), idempotency_key: "" },
    { ...order(), idempotency_key: "x".repeat(37) },
    { ...order(), shipping_address: { ...order().shipping_address, country: "US" } as never },
    { ...order(), shipping_address: { ...order().shipping_address, phone_number: "" } },
    { ...order(), shipping_address: { ...order().shipping_address, phone_number: "07700900123" } },
    { ...order(), products: [] },
    { ...order(), products: [{ url: PRODUCT_URL, quantity: 0 }] },
    { ...order(), products: [{ url: PRODUCT_URL, quantity: 1.5 }] },
    { ...order(), products: [{ url: PRODUCT_URL, variant: [{ label: "Size", value: "" }] }] },
    ...[
      "https://www.amazon.com/dp/B0C2J7Z17K",
      "https://amazon.co.uk.evil.test/dp/B0C2J7Z17K",
      "http://amazon.co.uk/dp/B0C2J7Z17K",
      "https://user:pass@amazon.co.uk/dp/B0C2J7Z17K",
      "https://amazon.co.uk:444/dp/B0C2J7Z17K",
      "https://amazon.co.uk/s?k=tea",
    ].map((url) => ({ ...order(), products: [{ url }] })),
  ];
  for (const input of invalid) await assert.rejects(api.placeOrder(input));
  assert.equal(seen.length, 0);
});

test("a negative, missing or wrong-storefront preflight never submits an order", async () => {
  for (const response of [
    { ...PREFLIGHT, orderable: false },
    { orderable: true, retailer: { retailer: "amazon", country: "US" } },
    { orderable: true },
  ]) {
    const { api, seen } = fake(() => Response.json(response));
    await assert.rejects(api.placeOrder(order()));
    assert.equal(seen.filter((r) => r.method === "POST").length, 0);
  }
});

test("caller changes during preflight cannot change the submitted purchase", async () => {
  const input = order();
  const { api, seen } = fake((request) => {
    if (new globalThis.URL(request.url).pathname === "/retailers/check") {
      input.max_price = 999999;
      input.idempotency_key = "different-purchase";
      input.products[0]!.quantity = 999;
      input.shipping_address.country = "US" as never;
      return Response.json(PREFLIGHT);
    }
    return Response.json(ORDER);
  });
  await api.placeOrder(input);
  const body = (await seen.at(-1)!.json()) as Submitted;
  assert.equal(body.max_price, 2000);
  assert.equal(body.idempotency_key, "logical-purchase-1");
  assert.equal(body.products[0]!.quantity, 2);
  assert.equal(body.shipping_address.country, "GB");
});

test("duplicate submission is a distinct successful outcome, with no new key or retry", async () => {
  const { api, seen } = fake((request) =>
    Response.json(
      request.method === "GET" ? PREFLIGHT : { code: "already_exists", message: "secret data" },
      { status: request.method === "GET" ? 200 : 409 },
    ),
  );
  assert.deepEqual(await api.placeOrder(order()), {
    outcome: "already_exists",
    idempotency_key: "logical-purchase-1",
  });
  assert.equal(seen.length, 2);
});

test("transport failure, 5xx and malformed accepted orders report unknown outcome without retry", async () => {
  for (const answer of [
    () => {
      throw new Error("api-key password in transport error");
    },
    () => Response.json({ code: "service_error", message: "api-key password" }, { status: 503 }),
    () => new Response("not json", { status: 201 }),
    () => Response.json({ ...ORDER, retailer_credentials_id: "zn_acct_other" }, { status: 201 }),
  ]) {
    const { api, seen } = fake((request) =>
      request.method === "GET" ? Response.json(PREFLIGHT) : answer(),
    );
    await assert.rejects(api.placeOrder(order()), (error: unknown) => {
      assert.ok(error instanceof ZincError);
      assert.equal(error.outcomeUnknown, true);
      assert.doesNotMatch(error.message, /api-key|password/);
      assert.match(error.message, /same idempotency key/);
      return true;
    });
    assert.equal(seen.length, 2);
  }
});

test("order reads and cancellation cannot address another managed account", async () => {
  const { api, seen } = fake(() =>
    Response.json({ ...ORDER, retailer_credentials_id: "zn_acct_other" }),
  );
  await assert.rejects(api.getOrder(ID), /configured account/);
  await assert.rejects(api.cancelOrder(ID), /configured account/);
  assert.ok(seen.every((r) => r.method === "GET"));
  await assert.rejects(api.getOrder("../managed-accounts"), /UUID/);
  assert.equal(seen.length, 2);
});

test("cancel refuses processing orders and sends one cancel for a pending job", async () => {
  const { api, seen } = fake();
  await api.cancelOrder(ID);
  assert.equal(seen.at(-1)!.url, `https://api.zinc.com/orders/${ID}/cancel`);
  const processing = fake(() => Response.json({ ...ORDER, status: "in_progress" }));
  await assert.rejects(processing.api.cancelOrder(ID), /pending/);
  assert.equal(processing.seen.length, 1);
});

test("search preserves provider fields but removes non-UK and invalid product URLs", async () => {
  const results: ZincObject[] = [
    { url: PRODUCT_URL, title: "UK product" },
    { url: "https://www.amazon.com/dp/B0C2J7Z17K", title: "US product" },
    { url: "https://amazon.co.uk.evil.test/dp/B0C2J7Z17K" },
  ];
  const { api, seen } = fake(() => Response.json({ status: "completed", results }));
  const found = await api.searchProducts("tea & biscuits", { limit: 10 });
  assert.deepEqual(found.results, [results[0]]);
  assert.equal(found.ukCoverageVerified, false);
  const params = new globalThis.URL(seen[0]!.url).searchParams;
  assert.equal(params.get("q"), "tea & biscuits");
  assert.equal(params.get("limit"), "10");
  assert.equal(params.get("retailer"), null); // amazon-uk is not a supported search enum
});

test("private registration sends credentials only to Zinc and returns only account identifiers", async () => {
  let request: Request | undefined;
  const account = await registerAmazonAccount({
    apiKey: "private-key",
    email: "research@example.com",
    password: "private-password",
    fetch: async (r) => {
      request = r;
      return Response.json({
        short_id: ACCOUNT,
        retailer: "amazon-uk",
        retailer_id: 42,
        password: "never-return-this",
        forwarding_email: "never-return-this",
      });
    },
  });
  assert.deepEqual(account, { retailerCredentialsId: ACCOUNT, retailerId: 42 });
  assert.equal(request!.url, "https://api.zinc.com/managed-accounts");
  assert.equal(request!.headers.get("authorization"), "Bearer private-key");
  assert.deepEqual(await request!.json(), {
    email: "research@example.com",
    password: "private-password",
    retailer: "amazon-uk",
  });
  await assert.rejects(
    registerAmazonAccount({
      apiKey: "private-key",
      email: "research@example.com",
      password: "private-password",
      fetch: async () =>
        Response.json(
          { error: { code: "bad_request", message: "private-password" } },
          { status: 400 },
        ),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private-key|private-password|research@example/);
      return true;
    },
  );
});

test("setup refuses a default, wrong or unlinked storefront", async () => {
  for (const response of [
    { short_id: ACCOUNT, retailer: null, retailer_id: null },
    { short_id: ACCOUNT, retailer: "amazon", retailer_id: 1 },
    { short_id: ACCOUNT, retailer: "amazon-uk", retailer_id: null },
  ])
    await assert.rejects(
      registerAmazonAccount({
        apiKey: "key",
        email: "research@example.com",
        password: "password",
        fetch: async () => Response.json(response),
      }),
      /link/,
    );
});

test("the shared transport cannot send a key to another origin", async () => {
  let calls = 0;
  const network = async () => {
    calls++;
    return Response.json({});
  };
  for (const path of ["https://evil.test/orders", "//evil.test/orders", "/\\evil.test/orders"])
    await assert.rejects(zincRequest(network, "Bearer private-key", path), /api.zinc.com/);
  assert.equal(calls, 0);
});
