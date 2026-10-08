# Waitrose

The Waitrose grocery API (search, trolley, orders, delivery slots, checkout) for an iterate project,
logged in with the person's own Waitrose account. There is no client to install: a run script, the
project's own code and an agent call Waitrose with plain `fetch`. Waitrose publishes no API docs, so
[Calling Waitrose](#calling-waitrose) is the doc.

The project never holds the password or the token: they live in a secret, and iterate's egress
swaps the token into each request and logs in again when Waitrose answers 401.

It is the package `iterate-waitrose`. `waitroseFetch` and `graphql` add what every call needs,
`OPERATIONS` holds the app's GraphQL operations, and `placeOrder` is the one call that spends money,
with its guards. The login is the secret's refresh. `waitrose()` is one element in the
`integrations` array of the project's config worker: the project's Integrations page in the Dash
shows a Waitrose card ("Set up by your coding agent" until the account's secret exists, with a link
to this recipe).

You are a coding agent with iterate's MCP server (`run({ script })`, `async (itx) => …` at the
project's root; read <https://os.iterate.com/connect-a-service.md> first if that is new to you, and
never take a secret in chat). Follow the steps in order.

## 1. The account, as a secret

```js
async (itx) =>
  itx.secrets.collectFromUser({
    path: "/secrets/waitrose",
    egress: { urls: ["https://www.waitrose.com"] },
    description:
      "Your Waitrose account: the email and password you sign in to waitrose.com with. They are only ever sent to waitrose.com.",
    fields: [
      { name: "username", label: "Email" },
      { name: "password", label: "Password" },
    ],
  });
```

Send the person the returned `url` and wait until they say it is saved. Then give the secret its
login, which is the module below (`EXCHANGE_SOURCE` in the package; it runs in a jail that can reach
`www.waitrose.com` and nothing else). Pass its text as `source`:

```js
async (itx) =>
  itx.secrets.set(
    "/secrets/waitrose",
    {},
    {
      urls: ["https://www.waitrose.com"],
      merge: true, // keeps the username and password the person saved
      refresh: { kind: "worker", source: `<the module below, as a string>` },
    },
  );
```

<!-- prettier-ignore -->
```js
export async function exchange(material, fetch) {
	const graphqlUrl = "https://www.waitrose.com/api/graphql-prod/graph/live";
	const newSession = "mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }";
	const { username, password } = material;
	if (typeof username !== "string" || !username || typeof password !== "string" || !password) throw new Error("waitrose: the secret's material has no \"username\" and \"password\"");
	const response = await fetch(graphqlUrl, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"user-agent": "Waitrose/3.9.1 (Android)"
		},
		body: JSON.stringify({
			query: newSession,
			variables: { input: {
				clientId: "ANDROID_APP",
				password,
				username
			} }
		})
	});
	if (response.status === 401) throw new Error("waitrose: login refused (HTTP 401): check the secret's username and password");
	if (!response.ok) throw new Error(`waitrose: login answered HTTP ${response.status}`);
	const session = (await response.json().catch(() => null))?.data?.generateSession;
	const failure = session?.failures?.[0]?.type;
	if (failure) throw new Error(`waitrose: login refused (${failure})`);
	if (!session?.accessToken) throw new Error("waitrose: login returned no accessToken");
	return {
		...material,
		accessToken: session.accessToken
	};
}
```

## 2. The package, in the project's config repo

Run the script in [add-to-a-project.md](../add-to-a-project.md) with these values. It pins the package
(built by this repo's CI and served by pkg.pr.new, never npm), adds the import and the element to the
`integrations` array of `worker.ts`, probes the result as a worker, and commits it.

```js
// the values for add-to-a-project.md
const PACKAGE = "iterate-waitrose";
const IMPORT = 'import { waitrose } from "iterate-waitrose";';
const ELEMENT = "waitrose()";
const MEMBER = "";
const FILES = {};
```

`waitrose()` has no host of its own. Its install hook (`project/worker-updated`) puts the Waitrose
card on the Dash. With the package in `package.json`, the project's code can import the helpers.

Earlier builds of this package served a `Waitrose` over Cap'n Web on the project's `waitrose` host,
and an earlier version of this recipe added `waitrose({ rpcResponse: iterateRpcResponse })` with an
import of `newWorkersRpcResponse`. The script leaves an element it finds as it is: change it to
`waitrose()`, and take that import out. Move any code that imports `Waitrose` or `WaitroseApi` to the
helpers first, in a commit of its own: otherwise the script's probe fails on the newer build and
nothing is committed.

### By hand, or copy the source

By hand: [add-to-a-project.md](../add-to-a-project.md#by-hand), with the import and the element above.
To copy the source instead, read [`src/index.ts`](src/index.ts) (`waitrose()` and the exports),
[`src/fetch.ts`](src/fetch.ts) (`waitroseFetch` and `graphql`),
[`src/operations.ts`](src/operations.ts), [`src/place-order.ts`](src/place-order.ts) and
[`src/exchange.ts`](src/exchange.ts), and commit them to `/repos/config` under `waitrose/`. They have
no dependencies. You own the copy. The import then reads `from "./waitrose/index.ts"`.

## 3. Prove it

Run the script in [The helpers in a script](#the-helpers-in-a-script) as it is. It calls
`graphql(OPERATIONS.GetShoppingContext)` and returns the account's shopping context. A `customerId`
and a `customerOrderId` back is the proof. The first call logs in by the secret's refresh, so it
takes a moment.

Then write into the project's `AGENTS.md` that agents call Waitrose with `fetch` and the token's
placeholder, with a link to this README's
[Calling Waitrose](https://github.com/jonastemplestein/iterategrations/tree/main/waitrose#calling-waitrose).

## Calling Waitrose

Read this before the first call. These are the Waitrose Android app's (v3.9.1) GraphQL and REST
services, as the package's earlier client called them. Every call is plain `fetch`. In every worker
the platform loads (the project's config worker, a run script), the global `fetch` is the project's
egress, so a run script, the project's code and an agent all call Waitrose the same way.

- **The placeholder:**
  `authorization: 'Bearer getSecret("/secrets/waitrose", { field: "accessToken" })'`, on every
  request. Egress swaps in the real token on the way out. It reads headers and the URL, never a
  body.
- **The origin:** `https://www.waitrose.com`, the only one the secret is pinned to. Egress sends the
  token nowhere else.
- **Expiry:** do nothing. When Waitrose answers 401, the platform logs in again by the secret's
  refresh ([`exchange.ts`](src/exchange.ts), step 1) and sends the request again, once. A 401 that
  still reaches you means that login failed too. The first call after the secret is saved logs in
  the same way. When that login fails, the answer is a 502 whose text says why.
- **The headers**, as `waitroseFetch` sends them:
  - `authorization`: the placeholder.
  - `user-agent: Waitrose/3.9.1 (Android)`. Waitrose's edge answers a request without one with HTTP 520.
  - `accept: application/json`.
  - `content-type: application/json`, when the request has a body.

### The helpers

The project's code imports them:

```ts
import { graphql, OPERATIONS, placeOrder, waitroseFetch } from "iterate-waitrose";
```

`waitroseFetch(input, init?)` is `fetch` with those headers merged in. Headers you pass win. This is
what `graphql(OPERATIONS.GetShoppingContext)` sends:

```js
const response = await waitroseFetch("https://www.waitrose.com/api/graphql-prod/graph/live", {
  method: "POST",
  body: JSON.stringify({ query: OPERATIONS.GetShoppingContext, variables: {} }),
});
const { data } = await response.json();
```

`graphql(operation, variables?)` posts `{ query, variables }` to
`https://www.waitrose.com/api/graphql-prod/graph/live` through `waitroseFetch`, and returns `data`.
It throws on an HTTP error (`HTTP <status>: <body>`), and on a non-empty `errors` list
(`GraphQL Error: <their messages>`).

```js
const { shoppingContext } = await graphql(OPERATIONS.GetShoppingContext);
const { getTrolley } = await graphql(OPERATIONS.GetTrolley, {
  orderId: shoppingContext.customerOrderId,
});
return getTrolley.trolley.trolleyTotals.totalEstimatedCost; // { amount, currencyCode }
```

`OPERATIONS` holds the app's 17 GraphQL operations by name, verbatim. Their text is in
[`src/operations.ts`](src/operations.ts); [GraphQL operations](#graphql-operations) says what each
one takes and returns. `placeOrder` places the current order: [Placing an order](#placing-an-order).

### The helpers in a script

A run script cannot import a package, so it starts with the helpers as text. Its `OPERATIONS` holds
only the operations the script calls: paste each one's text from
[`src/operations.ts`](src/operations.ts). As it is, this script reads the shopping context: the
customer, the current order and the branch, which most calls below need.

```js
async () => {
  // waitroseFetch and graphql, as the package exports them
  const waitroseFetch = (input, init = {}) => {
    const headers = new Headers({
      authorization: 'Bearer getSecret("/secrets/waitrose", { field: "accessToken" })',
      "user-agent": "Waitrose/3.9.1 (Android)",
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
    });
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    return fetch(input, { ...init, headers });
  };
  const graphql = async (operation, variables = {}) => {
    const response = await waitroseFetch("https://www.waitrose.com/api/graphql-prod/graph/live", {
      method: "POST",
      body: JSON.stringify({ query: operation, variables }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const { data, errors } = await response.json();
    if (errors?.length)
      throw new Error(`GraphQL Error: ${errors.map((e) => e.message).join(", ")}`);
    return data;
  };
  // the text of each operation the task calls, from src/operations.ts
  const OPERATIONS = {
    GetShoppingContext:
      "query GetShoppingContext { shoppingContext { customerId customerOrderId customerOrderState defaultBranchId } }",
  };
  const { shoppingContext } = await graphql(OPERATIONS.GetShoppingContext);

  // The task: the shopping context
  return shoppingContext;
};
```

Each example below is a task: keep everything above `// The task`, and put the example in place of
the rest. The project's code writes the same lines, with the helpers and `OPERATIONS` imported.

### GraphQL operations

Each goes to `graphql` with its variables. The trolley's `orderId`, and the `customerOrderId` of the
slot calls, are the current order: the shopping context's `customerOrderId`. The order calls take
any order's `customerOrderId`. A refusal comes back as a non-empty `failures` list
(`[{ type, message }]`) inside `data`, not as a GraphQL error, so `graphql` returns it: check it.

The account:

- `GetShoppingContext`, no variables: `shoppingContext`, with `customerId`, `customerOrderId`,
  `customerOrderState` and `defaultBranchId`.
- `GetAccountInfoAndMembership`, no variables: `getAccountProfile { id, email, contactAddress }`,
  and `getMemberships { memberships: [{ number, type }] }`, null without one.

The trolley. Each answers `trolley { orderId, trolleyItems, trolleyTotals, conflicts }`, the
`products` in it (name, price, size), `instantCheckout` (`ALLOWED`, `NOT_ALLOWED` or
`THRESHOLD_EXCEEDED`) and `failures`:

- `GetTrolley`, `{ orderId }`: `getTrolley`, the trolley, with `checkoutReadiness { slotTypeValid }`.
- `UpdateTrolleyItems`, `{ orderId, trolleyItemsInput }`: `updateTrolleyItems`. Each item is
  `{ lineNumber, quantity: { amount, uom }, noteToShopper?, canSubstitute? }`, and sets that line's
  quantity: `amount: 0` takes the line out, and `uom` is `C62` (each), `KGM` or `GRM`.
- `EmptyTrolley`, `{ orderId }`: `emptyTrolley`. It takes every line out.

Orders. An order is `{ customerOrderId, status, created, lastUpdated, totals, slots, orderLines }`.
The lists take these inputs (the earlier client's, with its default `size`; at most 15):

```js
const getPendingOrdersInput = {
  size: 10,
  sortBy: "+", // oldest first
  statuses: ["PAYMENT_FAILED", "PLACED", "FULFIL", "PAID", "PICKED"],
};
const getPreviousOrdersInput = {
  size: 10,
  sortBy: "-", // newest first
  statuses: ["COMPLETED", "CANCELLED", "REFUND_PENDING"],
};
```

- `GetPendingOrders`, `{ getPendingOrdersInput }`: `pendingOrders { content }`.
- `GetPreviousOrders`, `{ getPreviousOrdersInput }`: `previousOrders { content }`.
- `GetOrders`, `{ getPendingOrdersInput, getPreviousOrdersInput, getAmendingOrderInput }`:
  `pendingOrders`, `previousOrders` and `amendingOrder` in one request. The earlier client sent the
  two above instead, so it never chose a `getAmendingOrderInput`.
- `GetOrder`, `{ customerOrderId }`: `getOrder`, one order with its `orderLines` (quantities,
  prices, substitutions), `slots`, estimated and actual `totals`, and `paymentInfo`.
- `CancelOrder`, `{ input: customerOrderId }`: `cancelOrder { failures }`. It cancels the order.
- `InitiateAmendOrder`, `{ input: customerOrderId }`: `amendOrder { failures }`. It starts to amend
  a placed order.
- `CancelAmendOrder`, `{ input: customerOrderId }`: `cancelAmendOrder { failures }`. It stops the
  amendment.

Slots. `slotType` is `DELIVERY` or `COLLECTION`. `branchId` is the shopping context's
`defaultBranchId`, unless you choose another branch:

- `CurrentSlot`, `{ input: { customerOrderId, postcode? } }`: `currentSlot`, the booked slot (its
  type, branch, address, start, end, `expiryDateTime`, cutoffs and delivery charge), or null.
- `SlotDates`, `{ slotDatesInput: { slotType, branchId, customerOrderId, addressId? } }`:
  `slotDates { content: [{ id, dayOfWeek }], failures }`.
- `SlotDays`, `{ slotDaysInput: { slotType, branchId, customerOrderId, addressId?, fromDate } }`:
  `slotDays { content: [{ date, slots }], failures }`, each slot with its `id`, start, end, `status`,
  `charge`, `greenSlot` and `deliveryPassSlot`. `fromDate` is the `id` of a `SlotDates` entry.
- `BookSlot`, `{ input: { slotId, slotType, addressId? } }`: `bookSlot`, with the reservation's
  `slotExpiryDateTime`, its cutoffs, and `failures`. It books the slot.

Campaigns:

- `GetCampaigns`, no variables: `campaigns`, each with `id`, `name`, `startDate`, `endDate`,
  `marketingStartDate` and `marketingEndDate`.

### Products

Search, browse and promotions are Waitrose's CMS product content API, under
`https://www.waitrose.com/api/content-prod/v2/cms/publish/productcontent`. Each is a POST of
`{ customerSearchRequest: { queryParams } }` to `/search/<customerId>?clientType=WEB_APP` or
`/browse/<customerId>?clientType=WEB_APP`. `<customerId>` is the shopping context's, and `-1` asks
as a visitor who is not logged in.

The answer is `{ totalMatches, componentsAndProducts }`. Each product is an entry's `searchProduct`
(`id`, `lineNumber`, `name`, `brandName`, `displayPrice`, `size`, `thumbnail`, `promotions`, …); an
entry without one is not a product. `queryParams` takes:

- `start`, the offset of the first result (from 0), and `size`, the page size (at most about 128).
  Page `n` of 24 is `start: (n - 1) * 24, size: 24`.
- `sortBy`: `RELEVANCE` (what the earlier client sent by default), `PRICE_LOW_2_HIGH`,
  `PRICE_HIGH_2_LOW`, `A_2_Z`, `Z_2_A`, `TOP_RATED`, `MOST_POPULAR` or `CATEGORY_RANKING`.
- `filterTags` and `searchTags`, each a list of `{ group, value }`.
- Never a `branchId`: Waitrose answers no products to a search or a browse that names one.

Search by words:

```js
// The task: search
const response = await waitroseFetch(
  `https://www.waitrose.com/api/content-prod/v2/cms/publish/productcontent/search/${shoppingContext.customerId}?clientType=WEB_APP`,
  {
    method: "POST",
    body: JSON.stringify({
      customerSearchRequest: {
        queryParams: { searchTerm: "oat milk", start: 0, sortBy: "RELEVANCE", size: 24 },
      },
    }),
  },
);
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
const { totalMatches, componentsAndProducts = [] } = await response.json();
const products = componentsAndProducts.map((entry) => entry.searchProduct).filter(Boolean);
return {
  totalMatches,
  products: products.map(({ lineNumber, name, displayPrice }) => ({
    lineNumber,
    name,
    displayPrice,
  })),
};
```

Browse a category: `category` in place of `searchTerm`, sent to `/browse/`. Start from Groceries,
`"10051"`, and go down through the answer's `subCategories`
(`[{ categoryId, name, expectedResults, hiddenInNav }]`). A path such as `groceries/bakery` finds
nothing.

```js
// The task: browse Groceries
const response = await waitroseFetch(
  `https://www.waitrose.com/api/content-prod/v2/cms/publish/productcontent/browse/${shoppingContext.customerId}?clientType=WEB_APP`,
  {
    method: "POST",
    body: JSON.stringify({
      customerSearchRequest: { queryParams: { category: "10051", start: 0, sortBy: "RELEVANCE" } },
    }),
  },
);
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
const { totalMatches, subCategories } = await response.json();
return { totalMatches, subCategories };
```

The products on a promotion: a search with `promotionId` in place of `searchTerm`. A product's
`promotions` give each one's `promotionId`.

```js
// The task: the products on one promotion
const response = await waitroseFetch(
  `https://www.waitrose.com/api/content-prod/v2/cms/publish/productcontent/search/${shoppingContext.customerId}?clientType=WEB_APP`,
  {
    method: "POST",
    body: JSON.stringify({
      customerSearchRequest: {
        queryParams: { promotionId: "<a promotionId>", start: 0, sortBy: "RELEVANCE" },
      },
    }),
  },
);
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
const { totalMatches, componentsAndProducts = [] } = await response.json();
return {
  totalMatches,
  products: componentsAndProducts.map((entry) => entry.searchProduct).filter(Boolean),
};
```

Products by line number: a GET of
`https://www.waitrose.com/api/products-prod/v1/products/<line numbers, joined by +>`, with
`view=EXTENDED&excludeLinesWithConflicts=false&filterByCustomerSlot=false`, and the shopping
context's `defaultBranchId` as `branchId` when it has one. The answer is `{ products }`, each with
its `lineNumber`, `name`, `brandName`, `displayPrice`, `size`, `thumbnail`, `productImageUrls` and
`currentSaleUnitPrice`.

```js
// The task: two products by line number
const query = new URLSearchParams({
  view: "EXTENDED",
  excludeLinesWithConflicts: "false",
  filterByCustomerSlot: "false",
});
if (shoppingContext.defaultBranchId) query.set("branchId", shoppingContext.defaultBranchId);
const lineNumbers = ["<a line number>", "<another line number>"];
const response = await waitroseFetch(
  `https://www.waitrose.com/api/products-prod/v1/products/${lineNumbers.join("+")}?${query}`,
);
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
return (await response.json()).products ?? [];
```

### Placing an order

**`placeOrder` spends money.** It places the current order through Waitrose's instant checkout,
paid by the account's own payment setup. Never call it without the person's say-so for that order
and that total.

```js
const placed = await placeOrder({
  orderId: shoppingContext.customerOrderId,
  expectedTotal: { amount: 87.45, currencyCode: "GBP" }, // the total the person agreed to
});
```

`expectedTotal` is the trolley's `trolleyTotals.totalEstimatedCost`, from `GetTrolley`. In order,
`placeOrder`:

1. Checks its arguments: an `orderId` of letters, digits, `_` and `-`, and a total with an amount of
   0 or more and a currency.
2. Reads the shopping context again. Its current order must be `orderId`.
3. Reads the trolley (`GetTrolley`) and the current slot (`CurrentSlot`), and refuses with every
   blocker it finds: the trolley is another order; Waitrose reports trolley failures; instant
   checkout is not `ALLOWED`; there is no valid delivery or collection slot; the slot's reservation
   has expired; the trolley is empty; the minimum spend is not met; there are hard conflicts; there
   is no estimated total.
4. Refuses unless the estimated total is still `expectedTotal`, in amount and currency.
5. Sends one POST to the order-orchestration place endpoint, and never sends it again. This is
   its request; send it only through `placeOrder`:

   ```js
   await waitroseFetch(
     `https://www.waitrose.com/api/order-orchestration-prod/v1/orders/${encodeURIComponent(orderId)}/place`,
     {
       method: "POST",
       body: JSON.stringify({ instantCheckout: true, event: "PLACE" }),
       redirect: "manual",
       signal: AbortSignal.timeout(30_000),
     },
   );
   ```

6. Returns Waitrose's answer, `{ customerOrderId, totals, slots }`: the order instant checkout took,
   not a payment receipt.

When the answer is unclear (none within 30 seconds, a network failure, HTTP 408 or 5xx, or an
answer that is not the order), it throws `CheckoutOutcomeUnknownError`: the order may have been
placed. Read `GetPendingOrders` or `GetOrder` before anything else, and never place it again
blindly. Any other HTTP error is "Waitrose checkout rejected": Waitrose refused the order. Egress
sends a request again only after a 401, when Waitrose refused the token.

When instant checkout is not allowed, the person checks out on the website instead:
<https://www.waitrose.com/ecom/checkout>. It is a page, not an API.

A run script cannot import `placeOrder`. To let the project's agents place orders, give the
worker's class a method that calls it: an agent's script calls it as `itx.config.<method>(…)`.

## Notes

- The API and login are the Waitrose Android app's (v3.9.1) GraphQL and REST services at
  `www.waitrose.com/api/graphql-prod/graph/live` and its `content-prod`, `products-prod` and
  `order-orchestration-prod` siblings. Waitrose publishes no API; this can break when the app
  changes.
- Waitrose's login refuses a request that already carries a token, so the exchange sends none.
- Adapted from [jonastemplestein/waitrose](https://github.com/jonastemplestein/waitrose), which is
  the same API as a CLI.
- To remove it: take the element and its import out of `worker.ts`, and delete `/secrets/waitrose`.
  The Dash takes nothing away itself, so once that commit is live, take the card off with its null:
  `itx.cd("/integrations").append({ type: "events.iterate.com/integration/configured", payload: { integration: "waitrose", card: null } })`.
