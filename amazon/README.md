# Amazon UK

Agents shop through Amazon UK's website HTTP protocol. Chrome establishes the login session.
The local bridge then uses Node HTTP requests for search, products, basket changes and checkout.
It is available as `itx.amazon` through `iterate provide`.

The adapter came from requests captured in real Chrome with Playwriter on 6–7 October 2026.
The observed accounts include Amazon Business and a consumer account with shared Prime benefits.
It uses stored addresses and payment methods.
The website protocol is experimental. It is distinct from the officially documented
[Amazon Business Search, Cart and Ordering APIs](https://docs.business.amazon.com/docs/cart-api-overview),
which require developer onboarding and approved roles.

## Connect the account

Build the package, then use Playwriter with your real Chrome profile:

```sh
pnpm install
pnpm --filter iterate-amazon build
playwriter skill
playwriter browser list
playwriter session new --browser <the key of your Chrome profile>
```

Read the full Playwriter instructions before controlling Chrome. Use your own task tab.
Chrome cookies are shared with other tabs. The bootstrap does not switch or sign out of an account.

Set a private session-file path outside this repository, and the session ID from the command above:

```sh
export AMAZON_PLAYWRITER_SESSION=<session ID>
export AMAZON_SESSION_FILE=/absolute/private/amazon-session.json
node amazon/dist/bootstrap.js
```

The bootstrap opens its own Amazon tab and exports only Amazon cookies and the browser's user agent.
It writes the file with mode `600`. The bridge keeps cookie updates in that file. The agents do
not receive cookies or the account password.

If Chrome is not signed in, you can sign in in that task tab and run bootstrap again. For
email/password login, set `AMAZON_CREDENTIALS_FILE` to a private JSON file with `email` and
`password` fields before running bootstrap. This login branch is implemented but has not been
tested with a fresh account. A person must complete any CAPTCHA, OTP, passkey or account check.
Bootstrap stops when login does not complete. Never put the credential file in this repository.
The file must have mode `600`. If Chrome already has an Amazon login, the helper refuses a
credentials file. Omit that file to use the existing login, or switch accounts yourself first.

A session file grants account access. It is plain JSON with owner-only file permissions, not
application encryption. The bridge reads it once, holds the cookie jar in memory, and saves
Amazon's `Set-Cookie` updates. It has no automatic reauthentication or OAuth refresh token.
To renew a session, stop the bridge, complete login in Chrome, run bootstrap again, and restart
the bridge. Replacing the file while the bridge runs does not reload its in-memory cookies.

Keep it private and use a separate experimental account
when you want agents to have a separate basket.

## Lend the HTTP API to iterate

Use Node 22.18 or later and an iterate CLI with `provide`. Sign into the intended project:

```sh
iterate login
iterate provide amazon/dist/provide.js --name amazon --project <project>
```

The bridge runs on your computer and keeps the authentication state there. Chrome is needed for
login and later challenges. Normal shopping calls use HTTP. The bridge serializes calls so two
agents cannot change the same checkout at once. The platform description fits its 500-character limit.

Purchases are disabled unless the owner sets `AMAZON_MAX_ORDER_PENCE` before starting the bridge.
For example, `AMAZON_MAX_ORDER_PENCE=2500` permits orders up to £25.00. The exact final total
must also match the reviewed checkout. This is a per-order limit.

## Agent calls

```js
await itx.amazon.__describe();
const { results } = await itx.amazon.searchProducts("black pens", { page: 1 });
const product = await itx.amazon.getProduct(results[0].asin);
const basket = await itx.amazon.addToBasket(product.asin, 1);
const item = basket.find((item) => item.asin === product.asin);
await itx.amazon.setQuantity(item.id, 2);
await itx.amazon.selectBasketItem(item.id, true);
```

`getBasket()` returns item IDs, ASINs, titles, quantities, selection flags and unit prices in GBP
pence. `removeFromBasket(id)` deletes only that item. Search and product prices are site display
strings. Business prices can exclude VAT; use the checkout total for the final cost.

```js
let checkout = await itx.amazon.startCheckout();
// Read checkout.summary and checkout.forms. To change the stored address:
checkout = await itx.amazon.getCheckout({ step: "address" });
checkout = await itx.amazon.continueCheckout({
  checkoutId: checkout.id,
  formId: checkout.forms[0].id,
  // values: { addressID: <one of the displayed choices> },
});
// Repeat only for the displayed step. getCheckout() refreshes the review and its ID.
```

Checkout returns visible field names and their allowed choices. Hidden tokens stay in the bridge.
`continueCheckout` cannot change hidden fields or submit the final purchase form. Tested step
forms cover Business address selection and consumer confirmation of an already selected card.
At the consumer `payment` stage, read the displayed card and submit the `pay/continue` form
without changing its hidden widget fields. The bridge preserves the checkout context and
merges Amazon's response panels to obtain the review.
Dispatching items to addresses is implemented from captured forms. Payment choice changes,
new card entry, new address forms and other checkout variants need further capture.

After the owner has enabled purchases, read the final summary and use its exact total:

```js
if (!checkout.readyToOrder) throw new Error("Complete checkout first");
await itx.amazon.placeOrder({
  checkoutId: checkout.id,
  expectedTotalPence: checkout.totalPence,
});
```

The client fetches the review again. It rejects changed contents or totals. It consumes the
review before its single order POST. It never retries that POST. If the response is lost,
inspect Amazon orders before attempting another purchase. Amazon's website does not provide
a documented idempotency key for this request. A `submitted` result includes Amazon's response
summary; inspect it for confirmation or further required action.

Verify the order through Amazon's order history. A submitted request is not an order confirmation:

```js
await itx.amazon.getOrders({ search: "the product name" });
await itx.amazon.getOrders({ search: "the order number from those results" });
```

On the tested Business account, an exact order-number search returns the total and delivery
status. The Business history page loads its results through a read-only POST with a fresh page
token. Hidden tokens and customer identifiers stay inside the bridge. A search without a keyword
uses the account's default paid-by-you filters; it can omit orders paid by the organization.
On consumer accounts, `getOrders()` reads the default order-history page. Its `search` option
currently has no effect; inspect the returned order numbers, items, totals and delivery status.

## Validation and limits

Run contract tests with `pnpm --filter iterate-amazon test`. They cover token handling, hidden
field protection, origin restrictions, exact totals, changed reviews and uncertain purchase responses.

The optional live probe modifies a chosen item and restores the original basket. Choose an ASIN
which is absent from the basket. It cannot place an order:

```sh
AMAZON_PROBE_ASIN=<ASIN> node amazon/test/live-web.ts
```

`AMAZON_TRACE_FILE` saves a sanitized HTTP trace: methods, paths, field names and status codes.
It excludes cookies, token values, addresses and payment data. Do not publish raw HAR files.

See the [research report](../reports/Amazon%20UK%20agent%20shopping.md) for the exact live evidence.
On 6 October 2026, one explicitly approved order completed through a self-hosted Iterate MCP
server and this local HTTP bridge. Amazon's order history confirmed the product, exact total
and delivery status. The original basket was restored. The proof used a stored address and card
on an Amazon Business account. On 7 October 2026, a native project agent completed a second
explicitly approved purchase on a dedicated consumer account with shared Prime benefits. It
confirmed the saved card, preserved a fresh review, submitted once and verified the order number,
item, total and delivery window in Amazon's order history. The bridge ran on a Linux host; Chrome
on the Mac had established the session. Purchases were disabled again after verification.
Payment-choice changes, new address forms and other checkout variants remain untested.
Website changes or renewed authentication can stop calls.
The adapter returns `human_login_required` when it sees an authentication challenge.

## Other access routes

[Amazon Business APIs](https://docs.business.amazon.com/docs/ordering-api) provide official UK
search, cart and order placement after onboarding. An Amazon email and password does not grant
API roles or OAuth tokens.

The earlier [Zinc adapter](ZINC.md) remains available through the package's default config-worker
export and `./client`. Its UK support and currency handling need vendor confirmation. It gives
the Amazon credentials to Zinc. The direct HTTP bridge above keeps them on your computer.
