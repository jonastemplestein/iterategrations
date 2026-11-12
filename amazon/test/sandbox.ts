// Manual protocol smoke test. Only an anonymously minted zn_test_ key can reach order submission.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import assert from "node:assert/strict";
import { zincRequest, ZincError } from "../dist/transport.js";
import type { ZincObject } from "../dist/transport.js";

const keyFile = new URL("../.sandbox-key", import.meta.url);
let key: string;
if (existsSync(keyFile)) {
  key = readFileSync(keyFile, "utf8").trim();
} else {
  const response = await fetch("https://api.zinc.com/sandbox/keys", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "iterate-amazon protocol test" }),
  });
  if (!response.ok) throw new Error(`sandbox key mint failed: HTTP ${response.status}`);
  const minted = (await response.json()) as { api_key?: unknown };
  if (typeof minted.api_key !== "string") throw new Error("sandbox key mint returned no key");
  key = minted.api_key;
  if (!key.startsWith("zn_test_")) throw new Error("refusing a non-sandbox key");
  writeFileSync(keyFile, key, { mode: 0o600, flag: "wx" });
}
if (!key.startsWith("zn_test_")) throw new Error("refusing a non-sandbox key");
chmodSync(keyFile, 0o600);
const network = (request: Request): Promise<Response> =>
  globalThis.fetch(request, { signal: AbortSignal.timeout(30_000) });
// Sandbox responses omit real storefront/account linkage. Keep the production adapter's UK
// guards intact and test the shipped transport with Zinc's synthetic product instead.
const request = (path: string, body?: ZincObject): Promise<ZincObject> =>
  zincRequest(network, `Bearer ${key}`, path, body);
const draft: ZincObject = {
  products: [{ url: "https://zinc.com/shop/products/test-success" }],
  shipping_address: {
    first_name: "Sandbox",
    last_name: "Buyer",
    address_line1: "1 Test Street",
    city: "London",
    postal_code: "SW1A 1AA",
    phone_number: "+12025550123",
    country: "GB",
  },
  max_price: 5000,
  idempotency_key: crypto.randomUUID(),
};
const order = await request("/orders", draft);
if (typeof order.id !== "string") throw new Error("sandbox returned no order ID");
const read = await request(`/orders/${order.id}`);
await assert.rejects(
  request("/orders", draft),
  (error: unknown) => error instanceof ZincError && error.code === "already_exists",
);
console.log(
  JSON.stringify({
    sandbox: true,
    orderId: order.id,
    status: read.status,
    duplicateOutcome: "already_exists",
    realAmazonCheckoutVerified: false,
  }),
);
