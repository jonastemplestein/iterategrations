# Amazon UK through Zinc

This is the earlier Zinc alternative. The direct website HTTP bridge is in [README.md](README.md).

An experimental API integration for shopping on `amazon.co.uk` through
[Zinc v2](https://www.zinc.com/docs/v2/api-reference/orders/create-order). Agents can search,
check a product URL, submit an order, read its status, and cancel a pending Zinc job. The normal
calls run in an iterate config worker. They need no browser or always-on local process.

**This is an implemented adapter, not a verified UK checkout.** Zinc's live
[GB preflight](https://api.zinc.com/retailers/check?url=https%3A%2F%2Fwww.amazon.co.uk%2Fdp%2FB0C2J7Z17K&country=GB)
reports Amazon UK as orderable with the customer's account. It marks support as `observed`, with
no completed order recorded. Its UK account mapping and `max_price` currency still need vendor
confirmation. No real Amazon login or purchase was tested through Zinc. Purchases are disabled by default.
The access research was checked on 6 October 2026.

## Access options

| Route                                                                      | Account and access                                                             | Fit for this experiment                                                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Amazon Business APIs](https://docs.business.amazon.com/docs/ordering-api) | Business account, approved API roles, OAuth consent and purchasing-group setup | Official UK search, cart and ordering. Best option when onboarding is available. Ordinary email/password is insufficient.          |
| Zinc v2, implemented here                                                  | Zinc API key, billing setup, Amazon credentials registered with Zinc           | An API for agents. UK support is experimental. Zinc receives and stores the Amazon password.                                       |
| Browser through Playwriter                                                 | Normal Amazon account in the user's real Chrome, own task tab                  | Can use ordinary web checkout. A person handles SMS, passkeys and CAPTCHA. The direct HTTP bridge is now implemented in README.md. |
| [Rye](https://rye.com/docs/api-v2/developer-notes)                         | API key and payment setup                                                      | Current docs say US-only and no login/non-guest checkout. It does not meet the UK account requirement.                             |
| Affiliate APIs, Login with Amazon, SP-API                                  | Affiliate, profile or seller access                                            | These do not place ordinary customer orders.                                                                                       |

The [research report](../reports/Amazon%20UK%20agent%20shopping.md) compares these routes and links
the evidence. No maintained direct-HTTP consumer checkout client was found.

## 1. Register the Amazon account privately

Create a Zinc account at [app.zinc.com](https://app.zinc.com) and get its API key. Confirm with Zinc
that `amazon-uk` accounts and GB shipping work, which currency `max_price` expects, and how billing
and account challenges work. By default Zinc draws orders from its prepaid wallet. Account
credentials alone do not fund an order.

Use Zinc's private managed-account screen if it supports the UK storefront. Otherwise use the
included one-time setup helper. It sends `email`, `password` and `retailer: "amazon-uk"` to
`POST https://api.zinc.com/managed-accounts`. This gives Zinc the Amazon password. It creates a
credential record; it does not prove successful Amazon login.

On your own computer, put `ZINC_API_KEY`, `AMAZON_EMAIL` and `AMAZON_PASSWORD` in a private env file
outside the repository. Set the file's permissions to `0600`. Do not paste these values into chat
or put them in an agent-visible file. Then run:

```sh
pnpm install
pnpm --filter iterate-amazon build
node --env-file=/absolute/private/amazon-account.env amazon/dist/setup.js
```

The helper prints only `retailerCredentialsId` and `retailerId`. Keep the `zn_acct_…` short ID for
the config below. It refuses a wrong or unlinked storefront. A record can still have been created
when that check fails; inspect Zinc's dashboard before running setup again.

It does not configure TOTP, email/SMS forwarding, or CAPTCHA solving. If Amazon requests a
challenge, a person must complete it. This adapter has no interactive challenge protocol; a Zinc
order can fail until the provider and account holder resolve access.

## 2. Collect the Zinc API key as an iterate secret

Use iterate's MCP `run({ script })` in the target project. Read
<https://os.iterate.com/connect-a-service.md> if this is new to you.

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/zinc",
    egress: { urls: ["https://api.zinc.com"] },
    description:
      "Your Zinc API key from https://app.zinc.com. It is sent only to api.zinc.com. Amazon credentials are registered privately with Zinc, not stored in this project.",
  });
```

Send the returned collection URL to the person and wait for it to be saved. Never request the
key in chat. Only the API key needs iterate's secret substitution. Registration uses JSON
credentials, which iterate's URL/header-only secret substitution does not support.

## 3. Serve the member-only API

After this package is published by CI, pin `iterate-amazon` in the project's config `package.json`
to a full commit:

```json
{
  "dependencies": {
    "iterate-amazon": "https://pkg.pr.new/jonastemplestein/iterategrations/iterate-amazon@<40-hex sha>"
  }
}
```

Keep the config's other dependencies. Add `amazon.ts`:

```ts
export { Amazon } from "iterate-amazon";
```

In `worker.ts`, after fetch routes and before `if (!routingSlug)`:

```ts
import { newWorkersRpcResponse } from "iterate/sdk";
import { Amazon } from "./amazon.ts";

if (request.headers.get("x-iterate-routing-slug") === "amazon") {
  const denied = this.auth.require(request);
  if (denied) return denied;
  return newWorkersRpcResponse(
    request,
    new Amazon({
      fetch: (request) => this.withItx((itx) => itx.fetch(request)),
      retailerCredentialsId: "<your zn_acct_ short ID>",
      // Omit purchasePolicy until Zinc confirms UK checkout and the cap currency.
      // purchasePolicy: { maxPrice: <owner's integer cap in Zinc's confirmed units> },
    }),
  );
}
```

The worker pins the Amazon account and the price cap. Agents cannot change them in order
arguments. Only project members can call this route. Use a dedicated Zinc account/key for the
experiment: the provider key itself has broader powers than this adapter.

To work before package publication, copy `src/index.ts`, `src/client.ts` and `src/transport.ts`
under `amazon/` in the config repo, preserve their relative imports, and import `Amazon` from
`./amazon/index.ts`. The source has no runtime dependencies beyond `cloudflare:workers`.

## 4. Research and orders

Prove read access with a preflight. This is a retailer capability check, not proof of Amazon login:

```js
async (itx) => {
  const amazon = await itx.connectToCapnweb(await itx.url({ routingSlug: "amazon" }));
  try {
    return await amazon.checkRetailer("https://www.amazon.co.uk/dp/B0C2J7Z17K");
  } finally {
    amazon.close();
  }
};
```

`searchProducts(query, { limit: 20 })` uses Zinc's beta cross-retailer search and retains only
direct Amazon UK product URLs. UK discovery coverage is unconfirmed. An empty result does not
mean Amazon UK has no products: use the agent's normal web search with `site:amazon.co.uk`, then
preflight the chosen URL. Production search calls incur Zinc's documented data fee even with
purchases disabled; sandbox keys are free. See [search pricing](https://www.zinc.com/docs/v2/api-reference/search/cross-retailer).

After the owner enables the purchase policy, submit a purchase as follows. Persist the key and
the complete draft in the project before the network call. Keep that same key and draft when an
outcome is uncertain. The following is a template, not an instruction to buy this ASIN:

```js
async (itx) => {
  const draft = {
    products: [{ url: "https://www.amazon.co.uk/dp/<chosen ASIN>", quantity: 1 }],
    shipping_address: {
      first_name: "<first name>",
      last_name: "<last name>",
      address_line1: "<address>",
      city: "<city>",
      postal_code: "<postcode>",
      phone_number: "<phone>",
      country: "GB",
    },
    max_price: 2000, // Example provider units, not a claim that this is £20.
    idempotency_key: crypto.randomUUID(),
  };
  await itx.cd("/integrations/amazon/purchases").append({
    type: "amazon/purchase-draft",
    idempotencyKey: draft.idempotency_key,
    payload: { draft },
  });
  const amazon = await itx.connectToCapnweb(await itx.url({ routingSlug: "amazon" }));
  try {
    const result = await amazon.placeOrder(draft);
    await itx.cd("/integrations/amazon/purchases").append({
      type: "amazon/purchase-submitted",
      payload: { key: draft.idempotency_key, result },
    });
    return result;
  } finally {
    amazon.close();
  }
};
```

On recovery, read the saved draft. Do not rerun the example to generate a new key. `submitted`
means Zinc accepted a job; `pending` is not an Amazon purchase confirmation. Save its order UUID
and call `getOrder(uuid)` until `order_placed`, `order_failed`, or a cancellation state. Poll at
30–60 second intervals. `already_exists` means the original submission exists: inspect the saved
result or Zinc's dashboard to recover its order ID. Never treat it as a reason to create a new key.

`cancelOrder(uuid)` cancels only a pending Zinc job. It cannot cancel an Amazon order after
checkout starts. Orders use new-condition items and Zinc's default strict fulfillment. The
adapter accepts at most ten product entries and rejects non-UK URLs, non-GB shipping, invalid
quantities, missing keys and caps above the owner limit. The cap applies per order; it is not a
cumulative experiment budget, and provider fees can be additional.

## Validation

```sh
pnpm check
pnpm --filter iterate-amazon test
pnpm --filter iterate-amazon smoke  # optional network test; creates no real order
```

Tests cover account and destination pinning, policy caps, immutable order drafts, preflight
refusals, duplicate keys, ambiguous outcomes, cancellation, URL filtering and private setup.
They use mocked transport. The smoke script mints an anonymous test key, keeps it in the ignored
`.sandbox-key` file with mode `0600`, and exercises the shipped transport's submission, status and
duplicate-key handling with Zinc's synthetic product. The sandbox returns no real storefront or
managed-account link, so the script does not relax the adapter's UK checks. It refuses any key
without the `zn_test_` prefix. Use Node
22.18 or later for that script. A successful [Zinc sandbox](https://www.zinc.com/docs/v2/api-reference/introduction/sandbox)
call proves protocol compatibility, not real Amazon UK authentication or checkout. The config
worker route still needs a read-only test in the target iterate project after its key is saved.

On 6 October 2026, all 13 package tests passed. The network smoke test submitted a synthetic
order, read its pending status, and received `already_exists` on duplicate submission. Sandbox
managed-account registration returned a null UK storefront ID, and sandbox preflight returned
no storefront. The production adapter refused both; the smoke test uses synthetic transport
calls instead of relaxing those checks.
