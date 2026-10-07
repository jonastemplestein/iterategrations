import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { AmazonWebApi, AmazonWebError } from "../dist/web.js";
import type { WebFetch } from "../dist/web.js";
import { description } from "../dist/provide.js";

const basket = `<html><body><form id="activeCartViewForm"><input name="anti-csrftoken-a2z" value="private-csrf"><div id="sc-active-item" data-itemid="item" data-asin="B077G7XSJY" data-producttitle="Pens" data-quantity="1" data-isselected="1" data-price="10.89"></div></form><form id="gutterCartViewForm" action="/checkout/entry/cart" method="get"><input type="hidden" name="partialCheckoutCart" value="0"></form></body></html>`;
const review = (amount = "10.89", delivery = "Tomorrow") =>
  `<html><body><h2>Pens</h2><p>${delivery}</p><div class="order-summary-grid"><div class="order-summary-line-term">Order Total:</div><span data-shimmer-target="ordertotals-amount">£${amount}</span></div><span data-shimmer-target="ordertotals-amount">£0.00</span><form action="/checkout/p/p-test/spc/place-order" method="post"><input type="hidden" name="anti-csrftoken-a2z" value="private-order-csrf"><input type="hidden" name="consistencyToken" value="private-consistency"><input type="submit" name="placeYourOrder1"></form></body></html>`;
function fake(answer: (request: Request) => Response | Promise<Response>, maxOrderPence?: number) {
  const calls: Request[] = [];
  const fetch: WebFetch = async (request) => {
    calls.push(request.clone());
    return answer(request);
  };
  return { api: new AmazonWebApi({ fetch, maxOrderPence }), calls };
}
test("search parses observed result markup and rejects external product origins", async () => {
  const { api, calls } = fake(
    () =>
      new Response(
        '<div data-component-type="s-search-result" data-asin="B077G7XSJY"><h2>Pens</h2><span class="a-price"><span class="a-offscreen">£10.89</span></span></div>',
      ),
  );
  assert.equal((await api.searchProducts("pens")).results[0]?.asin, "B077G7XSJY");
  await assert.rejects(api.getProduct("https://evil.example/dp/B077G7XSJY"), /unexpected_origin/);
  await assert.rejects(api.getProduct("https://www.amazon.co.uk@evil.example/dp/B077G7XSJY"));
  assert.equal(calls.length, 1);
  assert(calls[0]!.url.includes("k=pens"));
});
test("basket actions obtain a fresh page token and address only the named item", async () => {
  const { api, calls } = fake((request) => new Response(request.method === "POST" ? "{}" : basket));
  await api.setQuantity("item", 2);
  const sent = calls.find((r) => r.method === "POST")!;
  assert.equal(sent.headers.get("anti-csrftoken-a2z"), "private-csrf");
  const body = new URLSearchParams(await sent.text());
  assert.deepEqual(JSON.parse(body.get("actionPayload")!), [
    {
      type: "UPDATE_QUANTITY_START",
      payload: {
        itemId: "item",
        list: "activeItems",
        relatedItemIds: [],
        isPrimeAsin: false,
        quantity: 2,
      },
    },
  ]);
  await assert.rejects(api.removeFromBasket("someone-elses-item"), /not_found/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});
test("order history uses a read-only request and excludes hidden authentication fields", async () => {
  const { api, calls } = fake(
    () =>
      new Response(
        '<html><body><p>Order 123-1234567-1234567: Arriving Thursday</p><input type="hidden" value="private-order-token"><script>private-script-token</script></body></html>',
      ),
  );
  const orders = await api.getOrders();
  assert.equal(orders.summary, "Order 123-1234567-1234567: Arriving Thursday");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(new URL(calls[0]!.url).pathname, "/gp/css/order-history");
});
test("Business order history loads the read-only panel with a private page token", async () => {
  const page =
    '<html><head><meta id="ab-your-orders-anticsrf-token" content="private-history-csrf"></head><body><script data-a-state=\'{"key":"yourOrdersStateData"}\'>{"loggedInCustomerId":"private-customer","marketplaceId":"market","sessionId":"private-session","businessId":"business"}</script><input id="originalRequestId" value="private-request"></body></html>';
  const { api, calls } = fake(async (request) => {
    if (request.method === "GET") return new Response(page);
    assert.equal(new URL(request.url).pathname, "/ab/your-orders/orderHistory");
    assert.equal(request.headers.get("anti-csrftoken-a2z"), "private-history-csrf");
    const params = new URLSearchParams(await request.text());
    const query = JSON.parse(params.get("orderHistoryRequestString")!);
    assert.equal(query.searchKeyword, "Huel");
    assert.equal(query.customerId, "private-customer");
    return new Response(
      '<section>Order 123-1234567-1234567: Huel arriving Thursday<input type="hidden" value="private-token"></section>',
    );
  });
  const orders = await api.getOrders({ search: "Huel" });
  assert.equal(orders.summary, "Order 123-1234567-1234567: Huel arriving Thursday");
  assert.equal(calls.length, 2);
  assert(!JSON.stringify(orders).includes("private-"));
});
test("checkout uses only selected items and keeps hidden tokens out of RPC results", async () => {
  const { api, calls } = fake(
    (request) =>
      new Response(new URL(request.url).pathname.startsWith("/checkout") ? review() : basket),
  );
  const checkout = await api.startCheckout();
  assert.equal(new URL(calls[1]!.url).searchParams.get("partialCheckoutCart"), "1");
  assert.equal(checkout.readyToOrder, true);
  assert.equal(checkout.totalPence, 1089);
  assert(!JSON.stringify(checkout).includes("private-"));
  assert.equal(checkout.forms.length, 0);
  await assert.rejects(
    api.placeOrder({ checkoutId: checkout.id, expectedTotalPence: 1089 }),
    /purchases_disabled/,
  );
  assert(!calls.some((c) => c.method === "POST"));
});
test("visible address choice may change; hidden authentication fields cannot", async () => {
  const address =
    '<html><head><meta name="anti-csrftoken-a2z" content="private-page-csrf"></head><body><form method="post" action="/checkout/p/p-test/business-address/continue"><input type="hidden" name="requestToken" value="secret"><label><input type="radio" name="addressID" value="a" checked>Address A</label><label><input type="radio" name="addressID" value="b">Address B</label></form></body></html>';
  const { api, calls } = fake(
    (request) =>
      new Response(
        request.method === "POST" ? review() : request.url.includes("/checkout") ? address : basket,
      ),
  );
  const checkout = await api.startCheckout();
  await assert.rejects(
    api.continueCheckout({
      checkoutId: checkout.id,
      formId: 0,
      values: { requestToken: "override" },
    }),
    /invalid_checkout_field/,
  );
  await assert.rejects(
    api.continueCheckout({
      checkoutId: checkout.id,
      formId: 0,
      values: { addressID: "not-a-choice" },
    }),
    /invalid_checkout_field/,
  );
  const next = await api.continueCheckout({
    checkoutId: checkout.id,
    formId: 0,
    values: { addressID: "b" },
  });
  assert(next.readyToOrder);
  const body = new URLSearchParams(await calls.find((c) => c.method === "POST")!.text());
  assert.equal(body.get("addressID"), "b");
  assert.equal(body.get("requestToken"), "secret");
});
test("consumer checkout confirms the saved card with private widget fields and public context", async () => {
  const payment = `<html><head><meta name="anti-csrftoken-a2z" content="private-page-csrf"></head><body><p>Test Mastercard 4242</p><form method="post" action="/checkout/p/p-test/pay/continue?referrer=cart&amp;cartItemCount=1"><input type="hidden" name="ppw-widgetState" value="private-widget-state"><input type="hidden" name="ppw-widgetRequest" value="private-widget-request"><input type="hidden" name="ppw-jsEnabled" value="true"></form></body></html>`;
  const { api, calls } = fake((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/gp/cart/view.html") return new Response(basket);
    if (request.method === "POST")
      return Response.json({ panels: [{ id: "checkout-review", content: review() }] });
    return new Response(payment);
  });
  const checkout = await api.startCheckout();
  assert.equal(checkout.stage, "payment");
  assert.equal(checkout.forms[0]?.purpose, "pay/continue");
  assert(!JSON.stringify(checkout).includes("private-"));
  const refreshed = await api.getCheckout({ step: "payment" });
  assert.equal(refreshed.stage, "payment");
  await assert.rejects(
    api.continueCheckout({
      checkoutId: refreshed.id,
      formId: 0,
      values: { "ppw-widgetRequest": "another-card" },
    }),
    /invalid_checkout_field/,
  );
  const approved = await api.continueCheckout({ checkoutId: refreshed.id, formId: 0 });
  assert.equal(approved.readyToOrder, true);
  assert.equal(approved.totalPence, 1089);
  const sent = calls.find((request) => request.method === "POST")!;
  assert.equal(new URL(sent.url).pathname, "/checkout/p/p-test/pay/continue");
  const body = new URLSearchParams(await sent.text());
  assert.equal(body.get("ppw-widgetState"), "private-widget-state");
  assert.equal(body.get("ppw-widgetRequest"), "private-widget-request");
  assert.equal(body.get("pipelineType"), "Chewbacca");
  assert.equal(body.get("cartItemCount"), "1");
  assert.equal(body.get("referrer"), "cart");
  assert.equal(sent.headers.get("anti-csrftoken-a2z"), "private-page-csrf");
  assert(!JSON.stringify(approved).includes("private-"));
  assert.equal(calls.filter((request) => request.method === "POST").length, 1);
});
test("purchase checks cap, exact total and a freshly unchanged review", async () => {
  let changed = false;
  const { api, calls } = fake(
    (request) =>
      new Response(
        request.url.includes("/checkout") ? review(changed ? "11.00" : "10.89") : basket,
      ),
    2000,
  );
  const checkout = await api.startCheckout();
  await assert.rejects(
    api.placeOrder({ checkoutId: checkout.id, expectedTotalPence: 1088 }),
    /mismatch/,
  );
  await assert.rejects(
    api.placeOrder({ checkoutId: checkout.id, expectedTotalPence: 2100 }),
    /mismatch/,
  );
  changed = true;
  await assert.rejects(
    api.placeOrder({ checkoutId: checkout.id, expectedTotalPence: 1089 }),
    /changed_review_again/,
  );
  assert(!calls.some((c) => c.method === "POST"));
});

test("purchase compares all review content even after a long item list", async () => {
  let changed = false;
  const { api, calls } = fake(
    (request) =>
      new Response(
        request.url.includes("/checkout")
          ? review("10.89", "Item details ".repeat(2000) + (changed ? "Address B" : "Address A"))
          : basket,
      ),
    2000,
  );
  const checkout = await api.startCheckout();
  assert(checkout.summary.length > 16000);
  assert(checkout.summary.includes("Address A"));
  changed = true;
  await assert.rejects(
    api.placeOrder({ checkoutId: checkout.id, expectedTotalPence: 1089 }),
    /changed_review_again/,
  );
  assert(!calls.some((c) => c.method === "POST"));
});
test("a lost purchase response consumes the review and never retries the POST", async () => {
  const { api, calls } = fake((request) => {
    if (request.method === "POST") throw new Error("secret vendor data");
    return new Response(request.url.includes("/checkout") ? review() : basket);
  }, 2000);
  const checkout = await api.startCheckout();
  await assert.rejects(
    api.placeOrder({ checkoutId: checkout.id, expectedTotalPence: 1089 }),
    (error: unknown) =>
      error instanceof AmazonWebError &&
      error.outcomeUnknown &&
      !error.message.includes("secret vendor"),
  );
  await assert.rejects(
    api.placeOrder({ checkoutId: checkout.id, expectedTotalPence: 1089 }),
    /stale_or_incomplete/,
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});
test("unknown purchase JSON stays private and consumes the submitted review", async () => {
  const { api, calls } = fake(
    (request) =>
      request.method === "POST"
        ? Response.json({ csrfToken: "private-response-token", result: "pending" })
        : new Response(request.url.includes("/checkout") ? review() : basket),
    2000,
  );
  const checkout = await api.startCheckout();
  const result = await api.placeOrder({ checkoutId: checkout.id, expectedTotalPence: 1089 });
  assert.deepEqual(result, { outcome: "submitted", summary: "" });
  await assert.rejects(
    api.placeOrder({ checkoutId: checkout.id, expectedTotalPence: 1089 }),
    /stale_or_incomplete/,
  );
  assert.equal(calls.filter((request) => request.method === "POST").length, 1);
});
test("redirects never forward session access to another host; login challenges stop calls", async () => {
  const bad = fake(
    () => new Response("", { status: 302, headers: { location: "https://evil.example/steal" } }),
  );
  await assert.rejects(bad.api.getBasket(), /unexpected_origin/);
  assert.equal(bad.calls.length, 1);
  const login = fake(() => new Response('<input id="auth-mfa-otpcode">'));
  await assert.rejects(login.api.getBasket(), /human_login_required/);
  assert(description.length <= 500);
});

test("checkout AJAX panels refresh private tokens before one guarded order POST", async () => {
  const initial = review()
    .replace("<body>", '<body><section id="checkout-subtotals-section">')
    .replace("</body>", "</section></body>");
  const content = review()
    .replace("<html><body>", "")
    .replace("</body></html>", "")
    .replace("private-order-csrf", "updated-csrf");
  const { api, calls } = fake(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/gp/cart/view.html") return new Response(basket);
    if (path === "/checkout/entry/cart") return new Response(initial);
    assert.equal(request.headers.get("x-amz-checkout-transition"), "ajax");
    assert.equal(request.headers.get("x-amz-checkout-type"), "spp");
    if (request.method === "POST") {
      assert.equal(request.headers.get("anti-csrftoken-a2z"), "updated-csrf");
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("anti-csrftoken-a2z"), "updated-csrf");
      assert.equal(body.get("placeYourOrder1"), "1");
      return new Response("<section>Thank you</section>");
    }
    return Response.json({ panels: [{ id: "checkout-subtotals-section", content }] });
  }, 2000);
  await api.startCheckout();
  const current = await api.getCheckout();
  assert(!JSON.stringify(current).includes("updated-csrf"));
  const placed = await api.placeOrder({ checkoutId: current.id, expectedTotalPence: 1089 });
  assert.equal(placed.outcome, "submitted");
  assert.equal(placed.summary, "Thank you");
  assert.equal(calls.filter((r) => r.method === "POST").length, 1);
});
