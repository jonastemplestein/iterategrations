import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { AmazonWebApi } from "../dist/web.js";
import { createSessionFetch } from "../dist/node-session.js";

const path = process.env.AMAZON_SESSION_FILE;
const asin = process.env.AMAZON_PROBE_ASIN;
if (!path || !asin)
  throw new Error(
    "Set AMAZON_SESSION_FILE and AMAZON_PROBE_ASIN for a reversible live basket probe",
  );
const trace: {
  method: string;
  path: string;
  queryKeys: string[];
  bodyKeys: string[];
  status: number;
}[] = [];
const transport = createSessionFetch(path);
// No order cap. This probe cannot call placeOrder successfully.
const api = new AmazonWebApi({
  fetch: async (request) => {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.clone().text() : null;
    const response = await transport(request);
    trace.push({
      method: request.method,
      path: url.pathname.replace(/p-\d+-\d+-\d+/g, "<purchase-id>"),
      queryKeys: [...url.searchParams.keys()],
      bodyKeys: body ? [...new URLSearchParams(body).keys()] : [],
      status: response.status,
    });
    return response;
  },
});
const baseline = await api.getBasket();
assert(!baseline.some((item) => item.asin === asin), "Choose a probe ASIN absent from the basket");
let testId: string | undefined;
try {
  const results = await api.searchProducts("bic cristal original black pens");
  assert(results.results.length);
  assert((await api.getProduct(asin)).canAddToBasket);
  const added = await api.addToBasket(asin);
  const item = added.find((i) => i.asin === asin);
  assert(item);
  testId = item.id;
  assert.equal(item.quantity, 1);
  console.log("HTTP search, product and add verified");
  assert.equal((await api.setQuantity(testId, 2)).find((i) => i.id === testId)?.quantity, 2);
  console.log("HTTP quantity verified");
  for (const item of baseline.filter((i) => i.selected))
    assert.equal(
      (await api.selectBasketItem(item.id, false)).find((i) => i.id === item.id)?.selected,
      false,
    );
  let checkout = await api.startCheckout();
  console.log({ checkoutStage: checkout.stage });
  for (let n = 0; n < 4 && !checkout.readyToOrder; n++) {
    assert(checkout.forms.length, "No supported checkout form");
    checkout = await api.continueCheckout({ checkoutId: checkout.id, formId: 0 });
    console.log({
      checkoutStage: checkout.stage,
      readyToOrder: checkout.readyToOrder,
      totalPence: checkout.totalPence,
    });
  }
  assert(checkout.readyToOrder, "Did not reach review");
  assert(checkout.totalPence && checkout.totalPence > 0);
  checkout = await api.getCheckout({ step: "address" });
  assert.equal(checkout.stage, "address");
  assert(checkout.forms.length);
  checkout = await api.continueCheckout({ checkoutId: checkout.id, formId: 0 });
  assert(checkout.readyToOrder);
  console.log("HTTP stored address selection verified");
  const refreshed = await api.getCheckout();
  assert.equal(refreshed.totalPence, checkout.totalPence);
  assert.equal(refreshed.summary, checkout.summary);
  console.log("Fresh review matches the reviewed contents and total");
  console.log("HTTP checkout review verified; placeOrder was not called");
} finally {
  // Recover an add whose response was lost, without touching baseline items.
  testId ??= (await api.getBasket()).find((i) => i.asin === asin)?.id;
  if (testId) await api.removeFromBasket(testId);
  for (const item of baseline) await api.selectBasketItem(item.id, item.selected);
  assert.deepEqual(await api.getBasket(), baseline);
  console.log("HTTP delete verified; original basket restored");
  if (process.env.AMAZON_TRACE_FILE)
    writeFileSync(
      process.env.AMAZON_TRACE_FILE,
      JSON.stringify(
        {
          date: new Date().toISOString().slice(0, 10),
          transport: "Node fetch",
          liveOrderSubmitted: false,
          requests: trace,
        },
        null,
        2,
      ),
    );
}
